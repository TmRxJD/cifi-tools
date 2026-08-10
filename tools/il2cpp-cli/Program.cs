using System;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;

namespace Il2CppDumper
{
    // Headless entry point around AndnixSH's Il2CppDumper-GUI fork, which is the only build that
    // parses IL2CPP metadata v39 (Unity 6.3). The fork ships WPF-only, so this reuses its parsing
    // and output code unchanged and supplies a console main instead of the window.
    internal static class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: Il2CppDumpCli <libil2cpp.so> <global-metadata.dat> <outputDir>");
                return 2;
            }
            Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);

            var il2cppPath = args[0];
            var metadataPath = args[1];
            var outputDir = args[2];
            Directory.CreateDirectory(outputDir);

            var config = new Config { RequireAnyKey = false, GenerateStruct = false };
            var cfgFile = Path.Combine(AppContext.BaseDirectory, "config.json");
            if (File.Exists(cfgFile))
            {
                config = JsonConvert.DeserializeObject<Config>(File.ReadAllText(cfgFile));
                config.RequireAnyKey = false;
                config.GenerateStruct = false; // needs the GUI's Settings; not required here
            }

            Console.WriteLine("Initializing metadata...");
            var metadataBytes = File.ReadAllBytes(metadataPath);
            var metadata = new Metadata(new MemoryStream(metadataBytes));
            Console.WriteLine($"Metadata Version: {metadata.Version}");

            Console.WriteLine("Initializing il2cpp file...");
            var il2cppBytes = File.ReadAllBytes(il2cppPath);
            var il2cppMagic = BitConverter.ToUInt32(il2cppBytes, 0);
            var il2CppMemory = new MemoryStream(il2cppBytes);
            Il2Cpp il2Cpp;
            switch (il2cppMagic)
            {
                default:
                    throw new NotSupportedException($"ERROR: unsupported file 0x{il2cppMagic:X}.");
                case 0x304F534E:
                    var nso = new NSO(il2CppMemory);
                    il2Cpp = nso.UnCompress();
                    break;
                case 0x905A4D:
                    il2Cpp = new PE(il2CppMemory);
                    break;
                case 0x464C457F:
                    if (il2cppBytes[4] == 2) il2Cpp = new Elf64(il2CppMemory);
                    else il2Cpp = new Elf(il2CppMemory);
                    break;
                case 0xCAFEBABE:
                case 0xBEBAFECA:
                    var machofat = new MachoFat(new MemoryStream(il2cppBytes));
                    var index = machofat.fats.Length - 1;
                    var magic = machofat.fats[index].magic;
                    il2cppBytes = machofat.GetMacho(index);
                    il2CppMemory = new MemoryStream(il2cppBytes);
                    if (magic == 0xFEEDFACF) goto case 0xFEEDFACF;
                    goto case 0xFEEDFACE;
                case 0xFEEDFACF:
                    il2Cpp = new Macho64(il2CppMemory);
                    break;
                case 0xFEEDFACE:
                    il2Cpp = new Macho(il2CppMemory);
                    break;
            }

            var version = config.ForceIl2CppVersion ? config.ForceVersion : metadata.Version;
            il2Cpp.SetProperties(version, metadata.metadataUsagesCount);
            Console.WriteLine($"Il2Cpp Version: {il2Cpp.Version}");

            Console.WriteLine("Searching...");
            var flag = il2Cpp.PlusSearch(
                metadata.methodDefs.Count(x => x.methodIndex >= 0),
                metadata.typeDefs.Length,
                metadata.imageDefs.Length);
            if (!flag) flag = il2Cpp.Search();
            if (!flag) flag = il2Cpp.SymbolSearch();
            if (!flag)
            {
                Console.Error.WriteLine("ERROR: auto mode could not locate CodeRegistration/MetadataRegistration.");
                return 1;
            }

            if (il2Cpp.Version >= 27 && il2Cpp.IsDumped)
            {
                var typeDef = metadata.typeDefs[0];
                var il2CppType = il2Cpp.types[typeDef.byvalTypeIndex];
                metadata.ImageBase = il2CppType.data.typeHandle - metadata.header.typeDefinitionsOffset;
            }

            var executor = new Il2CppExecutor(metadata, il2Cpp);

            Console.WriteLine("Dumping...");
            new Il2CppDecompiler(executor).Decompile(config, outputDir);
            Console.WriteLine("dump.cs written.");

            if (config.GenerateDummyDll)
            {
                Console.WriteLine("Generating dummy dll...");
                DummyAssemblyExporter.Export(executor, outputDir, config.DummyDllAddToken);
                Console.WriteLine("DummyDll written.");
            }

            Console.WriteLine("Done.");
            return 0;
        }
    }
}
