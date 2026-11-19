# Makes the shortcut in the app's folder ("Arabic Church Assistant.lnk") so that it keeps working when the folder is
# unzipped somewhere else or moved: besides the full path of the program it holds the path relative to itself
# (bin\Arabic Church Assistant.exe), which Windows uses when the full path is gone.
#   shortcut.ps1 -Link <file.lnk> -Target <program.exe> [-Icon <file.ico>]   make it
#   shortcut.ps1 -Link <file.lnk> -Resolve                                    say where it leads now (for tests)
param([Parameter(Mandatory = $true)][string]$Link, [string]$Target, [string]$Icon, [switch]$Resolve)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
public static class AcaShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int n, IntPtr fd, uint flags);
    void GetIDList(out IntPtr p);
    void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short k);
    void SetHotkey(short k);
    void GetShowCmd(out int c);
    void SetShowCmd(int c);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint r);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }
  public static void Make(string link, string target, string icon) {
    var l = (IShellLinkW)new CShellLink();
    l.SetPath(target);
    l.SetRelativePath(link, 0);            // (the shortcut's own path: Windows works out the path between the two)
    l.SetIconLocation(string.IsNullOrEmpty(icon) ? target : icon, 0);
    l.SetDescription("Arabic Church Assistant");
    ((IPersistFile)l).Save(link, true);
  }
  public static string Where(string link) {
    var l = (IShellLinkW)new CShellLink();
    ((IPersistFile)l).Load(link, 0);
    l.Resolve(IntPtr.Zero, 0x1 | 0x8 | 0x10 | 0x20);    // no window, no changes, no searching, no link tracking
    var s = new StringBuilder(1024);
    l.GetPath(s, s.Capacity, IntPtr.Zero, 0);
    return s.ToString();
  }
}
'@
if ($Resolve) { [AcaShortcut]::Where($Link) } else { [AcaShortcut]::Make($Link, $Target, $Icon) }
