using System;

// The GUI fork's parsing code logs through its WPF window. Rather than fork its source (which
// would mean re-porting every upstream fix by hand), supply the two types it reaches for so the
// same files compile unchanged into a console app.
namespace System.Windows.Media
{
    public sealed class Brush
    {
        public string Name { get; }
        public Brush(string name) { Name = name; }
    }

    public static class Brushes
    {
        public static Brush Orange { get; } = new Brush("orange");
        public static Brush Yellow { get; } = new Brush("yellow");
        public static Brush Khaki { get; } = new Brush("khaki");
        public static Brush Chartreuse { get; } = new Brush("chartreuse");
        public static Brush Red { get; } = new Brush("red");
        public static Brush White { get; } = new Brush("white");
        public static Brush LightGray { get; } = new Brush("lightgray");
        public static Brush Cyan { get; } = new Brush("cyan");
    }
}

namespace Il2CppDumper
{
    public static class MainForm
    {
        public static void Log(string message) => Console.WriteLine(message);

        public static void Log(string format, params object[] args)
        {
            // A Brush in the args position is a colour, not a format argument.
            if (args != null && args.Length == 1 && args[0] is System.Windows.Media.Brush)
            {
                Console.WriteLine(format);
                return;
            }
            Console.WriteLine(args == null || args.Length == 0 ? format : string.Format(format, args));
        }

        public static void Log(string message, System.Windows.Media.Brush brush) => Console.WriteLine(message);
    }
}

namespace Il2CppDumper
{
    // The generator reads the Il2CppDummyDll assembly out of the WPF project's generated resource
    // class. Load the same file from disk instead so no designer-generated code is needed.
    internal static class Resource1
    {
        private static byte[] cached;

        internal static byte[] Il2CppDummyDll
        {
            get
            {
                if (cached != null) return cached;
                var path = System.IO.Path.Combine(System.AppContext.BaseDirectory, "Il2CppDummyDll.dll");
                if (!System.IO.File.Exists(path))
                {
                    throw new System.IO.FileNotFoundException(
                        "Il2CppDummyDll.dll must sit next to the executable (copied from the GUI fork's Libraries/).", path);
                }
                cached = System.IO.File.ReadAllBytes(path);
                return cached;
            }
        }
    }
}
