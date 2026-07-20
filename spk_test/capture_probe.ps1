# Which of cue's windows are actually protected, and does a GDI screenshot see them?
$sig = @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class Cap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  // The readback that tells us whether the flag actually took effect.
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  public struct RECT { public int L,T,R,B; }

  public static List<string> Report(uint[] pids) {
    var o = new List<string>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var t = new StringBuilder(64); GetWindowTextW(h, t, 64);
      var c = new StringBuilder(64); GetClassNameW(h, c, 64);
      RECT r; GetWindowRect(h, out r);
      uint aff = 0; bool got = GetWindowDisplayAffinity(h, out aff);
      string name = aff == 0 ? "NONE (capturable)" : aff == 1 ? "WDA_MONITOR (black box)" : aff == 0x11 ? "EXCLUDEFROMCAPTURE" : ("0x" + aff.ToString("X"));
      o.Add(string.Format("  hwnd=0x{0:X}  vis={1,-5}  {2,-28}  affinity={3}  title='{4}' class='{5}'",
        (long)h, IsWindowVisible(h), (r.R-r.L)+"x"+(r.B-r.T)+" @"+r.L+","+r.T, name, t, c));
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
$pids = @(Get-Process cue,electron -EA SilentlyContinue | ForEach-Object { [uint32]$_.Id })
if (-not $pids) { "no cue process running"; exit }
"=== every HWND owned by cue, with its real display affinity ==="
[Cap]::Report($pids) | ForEach-Object { $_ }

# GDI BitBlt path -- the classic screenshot route
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 3840,2160
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0,0,0,0,$b.Size)
$g.Dispose()
$b.Save("$env:TEMP\cue_gdi_capture.png",[System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
"=== GDI CopyFromScreen (BitBlt) written to $env:TEMP\cue_gdi_capture.png ==="
