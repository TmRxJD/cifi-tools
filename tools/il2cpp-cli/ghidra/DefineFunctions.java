// Define every IL2CPP method as a real Ghidra Function, from dump.cs ground truth.
//
// THIS IS THE FIX for the decompiler's runaway output, and it has to be global -- an earlier
// attempt patched it per decompile target and could not work. The mechanism, read out of Ghidra's
// own source rather than guessed:
//
//   * `Funcdata::startProcessing` (funcdata.cc) calls `followFlow(baddr=0, eaddr=~0)` -- the
//     decompiler follows flow across the ENTIRE address space and never consults the function
//     body. So `Function.setBody()` cannot bound it. Measured: a body stayed pinned at its exact
//     454 bytes while the output ballooned to ~960k chars.
//   * `FlowInfo::checkContainedCall` (flow.cc) rewrites a CALL into a BRANCH -- inlining the
//     callee -- when `fc->getFuncdata() == null` AND the callee entry is already in `visited`.
//   * `getFuncdata()` is set only in `FlowInfo::queryCall`, which resolves through
//     `ScopeGhidra::findFunction` -> `getMappedSymbolsXML` -> Java `DecompileCallback
//     .getMappedSymbols`. That returns a function symbol only when `getFunctionContaining(addr)`
//     finds a real Function. A LABEL is not enough (it encodes a HighLabelSymbol, and the C++
//     `dynamic_cast<FunctionSymbol*>` then fails) -- so symbol-import scripts do not fix this.
//   * With `-noanalysis`, Ghidra's `FunctionAnalyzer` ("Subroutine References", whose stated job
//     is "Create Function definitions for code that is called") never runs, so nothing creates
//     functions at call targets. That is what removed the safety net.
//   * Negative answers are STICKY: `ScopeGhidra::removeQuery` short-circuits on a cached hole and
//     `decodeHole` inserts one. A range queried before its function exists stays poisoned for the
//     rest of the session -- so every function must exist BEFORE any decompilation starts.
//
// Defining all of them kills both conjuncts at once: no call target is unknown, and flow stops
// running off the end of one method into the next.
//
// Why Java and not PyGhidra: this is ~300k API calls (getFunctionAt + createFunction +
// setNoReturn). JPype crosses the JNI boundary on each one; JPype's own docs say to move
// time-critical loops into Java. A GhidraScript also gets its single transaction for free
// (`GhidraScript.executeNormal` wraps `run()` in start/end), which a PyGhidra session does not.
//
// Two things that silently produce nothing, both verified in Ghidra's source:
//   * `CreateFunctionCmd` NEVER disassembles. An entry over undefined bytes yields a 1-byte body
//     with no instructions -- a function that exists and decompiles to nothing. Disassemble first.
//   * `FlatProgramAPI.createFunction(addr, name)` passes a NULL body, which makes CreateFunctionCmd
//     run a FollowFlow graph walk per call. We already know every body from the RVA table, so
//     `FunctionManager.createFunction(name, entry, body, source)` skips that entirely.
//
// Input is the TSV from tools/il2cpp-cli/export-functions.py:  <rva-hex> <end-hex> <returns> <name>
//
// @category IL2CPP
import ghidra.app.script.GhidraScript;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.SourceType;

import java.io.BufferedReader;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.List;

public class DefineFunctions extends GhidraScript {

    private static final class Entry {
        final long start, end;
        final boolean returns;
        final String name;
        Entry(long s, long e, boolean r, String n) { start = s; end = e; returns = r; name = n; }
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: DefineFunctions <functions.tsv>");
            return;
        }

        // dump.cs RVAs assume image base 0. Ghidra's ELF loader picks 0x100000 for a shared
        // object, and every address would then land somewhere plausible but wrong -- the worst
        // failure mode, because you still get output.
        long base = currentProgram.getImageBase().getOffset();
        if (base != 0) {
            println("rebasing from 0x" + Long.toHexString(base) + " to 0");
            currentProgram.setImageBase(
                currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(0), true);
        }
        if (currentProgram.getImageBase().getOffset() != 0) {
            println("ERROR: image base is not 0; refusing to define functions at wrong addresses");
            return;
        }

        List<Entry> entries = new ArrayList<>(120000);
        AddressSet all = new AddressSet();
        try (BufferedReader r = new BufferedReader(new FileReader(args[0]))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty()) continue;
                String[] p = line.split("\t");
                if (p.length < 4) continue;
                long s = Long.parseLong(p[0], 16);
                long e = Long.parseLong(p[1], 16);
                if (e <= s) e = s + 1;
                entries.add(new Entry(s, e, "1".equals(p[2]), p[3]));
                all.addRange(toAddr(s), toAddr(e - 1));
            }
        }
        println("read " + entries.size() + " function definition(s)");

        // Restrict flow to the set we are defining, so disassembly cannot wander into data.
        println("disassembling...");
        long t0 = System.currentTimeMillis();
        new DisassembleCommand(all, all, true).applyTo(currentProgram, monitor);
        println("disassembled in " + (System.currentTimeMillis() - t0) / 1000 + "s");

        FunctionManager fm = currentProgram.getFunctionManager();
        int made = 0, existed = 0, failed = 0, noReturn = 0;
        t0 = System.currentTimeMillis();
        for (int i = 0; i < entries.size(); i++) {
            if (monitor.isCancelled()) break;
            Entry en = entries.get(i);
            Address entry = toAddr(en.start);
            try {
                Function fn = fm.getFunctionAt(entry);
                if (fn == null) {
                    AddressSet body = new AddressSet(entry, toAddr(en.end - 1));
                    fn = fm.createFunction(en.name, entry, body, SourceType.USER_DEFINED);
                    if (fn != null) made++; else { failed++; continue; }
                } else {
                    existed++;
                }
                // The returns flag is why IL2CPP getters do not cascade: they END with a call to a
                // throw/abort helper that never returns, and if Ghidra believes it returns, flow
                // falls through past the end of every method into the next one.
                if (!en.returns) { fn.setNoReturn(true); noReturn++; }
            } catch (Exception ex) {
                failed++;   // overlaps an existing function/namespace; counted, never swallowed
            }
            if (i > 0 && i % 20000 == 0) {
                println("  " + i + "/" + entries.size() + " made=" + made + " failed=" + failed
                        + " (" + (System.currentTimeMillis() - t0) / 1000 + "s)");
            }
        }
        println("created=" + made + " alreadyExisted=" + existed + " failed=" + failed
                + " markedNonReturning=" + noReturn
                + " in " + (System.currentTimeMillis() - t0) / 1000 + "s");
    }
}
