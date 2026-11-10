# Windows "the session is ending" guard for the tray.
#
# Why this is needed: on shutdown, restart or logoff Windows terminates the backend with exit code
# 0x40010004 and gives a console process no notification node can catch - shutdown() never runs, and
# data/run.json survives, so the next start reports an abnormal exit that never happened. Only a GUI
# process gets asked first: Windows sends WM_QUERYENDSESSION to top-level windows and waits for each
# one. .NET exposes that as Microsoft.Win32.SystemEvents.SessionEnding, and the tray owns a hidden
# window, so the tray is the one place that can ask the backend to exit while it still has time.
#
# The handler is compiled C# (Add-Type) on purpose: SystemEvents raises SessionEnding on its own
# thread, where a PowerShell script block has no runspace and silently never runs (the delegate is
# accepted, nothing executes). The handler only writes one loopback HTTP request and waits for the
# backend process, so it never needs the tray's PowerShell state from that thread.

function Install-SessionEndGuard {
  [CmdletBinding()]
  param()

  # The tray may re-install after a restart of the script; the type can only be compiled once.
  if ('SessionEndGuard' -as [type]) {
    [SessionEndGuard]::Attach()
    return
  }

  # Windows PowerShell 5.1 keeps Microsoft.Win32.SystemEvents inside System.dll; PowerShell 7 ships
  # it as its own assembly and loads it on first use.
  try { Add-Type -AssemblyName Microsoft.Win32.SystemEvents -ErrorAction Stop } catch { }

  $code = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public static class SessionEndGuard
{
    private const int SM_SHUTTINGDOWN = 0x2000;
    private static readonly object Gate = new object();
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static int port;
    private static int ownerPid;
    private static string logPath = string.Empty;
    private static int ending;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    // The tray watchdog asks this before restarting a backend that Windows just took down.
    public static bool SessionEnding
    {
        get { return Volatile.Read(ref ending) != 0; }
    }

    // Independent of the notification: the documented "this session is shutting down" metric. Used
    // when the backend died first and the watchdog only noticed on its next tick.
    public static bool IsSessionShuttingDown()
    {
        return GetSystemMetrics(SM_SHUTTINGDOWN) != 0;
    }

    public static void Attach()
    {
        lock (Gate)
        {
            SystemEvents.SessionEnding -= HandleSessionEnding;
            SystemEvents.SessionEnding += HandleSessionEnding;
        }
    }

    // Port, pid of the backend the tray started (0 when it was started outside the tray) and the
    // log file. Called again after every start/stop and after a settings.json dataDir change.
    public static void SetTarget(int newPort, int newOwnerPid, string newLogPath)
    {
        lock (Gate)
        {
            port = newPort;
            ownerPid = newOwnerPid;
            logPath = newLogPath ?? string.Empty;
        }
    }

    // A shutdown blocked by another app leaves the flag set: the tray's Start/Restart clears it so
    // the watchdog does not stay paused for the rest of the session.
    public static void Reset()
    {
        Interlocked.Exchange(ref ending, 0);
    }

    // Public so the tray and its tests can run exactly what the event handler runs.
    public static bool StopBackend(string reason)
    {
        int targetPort;
        int targetPid;
        string targetLog;
        lock (Gate)
        {
            targetPort = port;
            targetPid = ownerPid;
            targetLog = logPath;
        }
        if (targetPort <= 0)
        {
            Write(targetLog, reason + ": no backend port to stop");
            return false;
        }

        if (!PostShutdown(targetPort))
        {
            Write(targetLog, reason + ": backend did not answer the shutdown request; Windows will terminate it");
            return false;
        }
        if (targetPid <= 0)
        {
            Write(targetLog, reason + ": backend asked to exit");
            return true;
        }
        try
        {
            using (Process backend = Process.GetProcessById(targetPid))
            {
                if (!backend.WaitForExit(3000))
                {
                    Write(targetLog, reason + ": backend pid " + targetPid.ToString() + " is still running after the shutdown request");
                    return false;
                }
            }
        }
        catch (ArgumentException)
        {
            // already gone: the clean exit finished before the request returned
        }
        Write(targetLog, reason + ": backend pid " + targetPid.ToString() + " stopped cleanly before the shutdown");
        return true;
    }

    private static void HandleSessionEnding(object sender, SessionEndingEventArgs e)
    {
        // Windows sends the notification again for a logoff followed by a shutdown; only clean up once
        if (Interlocked.Exchange(ref ending, 1) != 0) return;
        try
        {
            StopBackend(e.Reason == SessionEndReasons.Logoff ? "logoff" : "shutdown");
        }
        catch (Exception ex)
        {
            // An exception escaping the window procedure would pop up a Windows error dialog mid-shutdown
            Write(logPath, "session ending: cleanup failed: " + ex.Message);
        }
    }

    private static bool PostShutdown(int targetPort)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult connecting = client.BeginConnect("127.0.0.1", targetPort, null, null);
                if (!connecting.AsyncWaitHandle.WaitOne(1000)) return false;
                client.EndConnect(connecting);
                using (NetworkStream stream = client.GetStream())
                {
                    stream.ReadTimeout = 1500;
                    // Same-origin POST, the one request /api/shutdown accepts without a token.
                    string head =
                        "POST /api/shutdown HTTP/1.1\r\n" +
                        "Host: 127.0.0.1:" + targetPort.ToString() + "\r\n" +
                        "Origin: http://127.0.0.1:" + targetPort.ToString() + "\r\n" +
                        "Content-Length: 0\r\n" +
                        "Connection: close\r\n\r\n";
                    byte[] request = Encoding.ASCII.GetBytes(head);
                    stream.Write(request, 0, request.Length);
                    stream.Flush();
                    // The reply is irrelevant: the process actually exiting is the proof, and reading
                    // it keeps the socket from being reset under the server.
                    byte[] reply = new byte[128];
                    try { stream.Read(reply, 0, reply.Length); }
                    catch (IOException) { }
                }
            }
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void Write(string targetLog, string message)
    {
        if (string.IsNullOrEmpty(targetLog)) return;
        try
        {
            File.AppendAllText(targetLog, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + "\r\n", Utf8);
        }
        catch (Exception)
        {
            // best effort: a shutdown must never be blocked by logging
        }
    }
}
'@

  # Add-Type compiles against what this session already loaded; naming the assemblies keeps the
  # build working on both PowerShell 7 and Windows PowerShell 5.1. PowerShell 7 ships its reference
  # assemblies in $PSHOME\ref - passing implementation assemblies instead loses System.Text and
  # friends - while 5.1 keeps everything in System.dll.
  $refDir = Join-Path $PSHOME 'ref'
  if (Test-Path $refDir) {
    $references = @(Get-ChildItem (Join-Path $refDir '*.dll') | ForEach-Object { $_.FullName })
  } else {
    $references = @(
      [System.Net.Sockets.TcpClient].Assembly.Location
      [System.Diagnostics.Process].Assembly.Location
    )
  }
  # SystemEvents is not part of the base reference set in PowerShell 7, so it is always added
  $references += [Microsoft.Win32.SystemEvents].Assembly.Location
  $references = $references | Where-Object { $_ } | Select-Object -Unique

  Add-Type -TypeDefinition $code -ReferencedAssemblies $references -ErrorAction Stop
  [SessionEndGuard]::Attach()
}
