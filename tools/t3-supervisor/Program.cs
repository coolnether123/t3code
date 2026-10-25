using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static class Program
{
    private const string InstanceMutexPrefix = @"Global\T3CodeSupervisor-";
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan HealthInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan HealthTimeout = TimeSpan.FromSeconds(8);
    private const int FailedHealthChecksBeforeRestart = 6;

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 6 && args[0] == "--release-config" && args[2] == "--node" && args[4] == "--mode")
        {
            var configPath = Path.GetFullPath(args[1]);
            using var config = System.Text.Json.JsonDocument.Parse(File.ReadAllText(configPath));
            var start = new ProcessStartInfo(args[3]) { UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add(config.RootElement.GetProperty("supervisorScript").GetString()!);
            start.ArgumentList.Add(configPath);
            start.ArgumentList.Add(args[5]);
            using var wrapperLog = new RotatingLog(Path.Combine(Path.GetDirectoryName(configPath)!, $"{args[5]}-wrapper.log"));
            using var job = WindowsJob.CreateKillOnClose(wrapperLog);
            using var child = Process.Start(start)!;
            job.TryAssign(child, wrapperLog);
            await child.WaitForExitAsync();
            return child.ExitCode;
        }
        Configuration configuration;
        try
        {
            configuration = Configuration.Parse(args);
        }
        catch (Exception)
        {
            return 2;
        }

        Directory.CreateDirectory(configuration.LogDirectory);
        using var log = new RotatingLog(Path.Combine(configuration.LogDirectory, $"{configuration.Mode}-supervisor.log"));
        var instanceKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(configuration.BaseDirectory.ToUpperInvariant())))[..16];
        using var instanceMutex = new Mutex(true, $"{InstanceMutexPrefix}{instanceKey}-{configuration.Mode}", out var ownsMutex);
        if (!ownsMutex)
        {
            log.Write("A supervisor instance is already running; this instance will exit.");
            return 0;
        }

        using var stop = new CancellationTokenSource();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.Cancel();
        log.Write($"Supervisor started as {Environment.UserDomainName}\\{Environment.UserName}.");

        try
        {
            await RunSupervisor(configuration, log, stop.Token);
            return 0;
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            log.Write("Supervisor stopped.");
            return 0;
        }
        catch (Exception error)
        {
            log.Write($"Supervisor failed: {error}");
            return 1;
        }
    }

    private static async Task RunSupervisor(
        Configuration configuration,
        RotatingLog log,
        CancellationToken cancellationToken)
    {
        var restartDelay = TimeSpan.FromSeconds(5);

        while (!cancellationToken.IsCancellationRequested)
        {
            var startedAt = DateTimeOffset.UtcNow;
            using var job = WindowsJob.CreateKillOnClose(log);
            using var server = StartServer(configuration, log);
            job.TryAssign(server, log);
            log.Write($"Started T3 Code server PID {server.Id}.");

            var ready = await WaitForReady(server, configuration.HealthUrl, log, cancellationToken);
            if (ready)
            {
                restartDelay = TimeSpan.FromSeconds(5);
                await MonitorHealthyServer(server, configuration.HealthUrl, log, cancellationToken);
            }
            else if (!server.HasExited)
            {
                log.Write($"Server PID {server.Id} did not become ready within {StartupTimeout.TotalMinutes:0} minutes.");
            }

            await StopServer(server, log);
            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            if (DateTimeOffset.UtcNow - startedAt < TimeSpan.FromMinutes(5))
            {
                restartDelay = TimeSpan.FromSeconds(Math.Min(restartDelay.TotalSeconds * 2, 60));
            }

            log.Write($"Restarting in {restartDelay.TotalSeconds:0} seconds.");
            await Task.Delay(restartDelay, cancellationToken);
        }
    }

    private static Process StartServer(Configuration configuration, RotatingLog log)
    {
        var start = new ProcessStartInfo
        {
            FileName = configuration.NodePath,
            WorkingDirectory = configuration.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(configuration.ServerEntryPath);
        if (configuration.Mode == "web")
        {
            start.ArgumentList.Add("dev");
            start.ArgumentList.Add("--host");
            start.ArgumentList.Add("127.0.0.1");
            start.ArgumentList.Add("--port");
            start.ArgumentList.Add("6803");
            start.Environment["T3CODE_PORT_OFFSET"] = "1070";
            start.Environment["T3CODE_PORT"] = "3774";
            start.Environment["PORT"] = "6803";
            start.Environment["T3CODE_SINGLE_ORIGIN_DEV"] = "1";
        }
        else
        {
            start.ArgumentList.Add("serve");
            start.ArgumentList.Add("--host");
            start.ArgumentList.Add("127.0.0.1");
            start.ArgumentList.Add("--port");
            start.ArgumentList.Add("3774");
            start.ArgumentList.Add("--base-dir");
            start.ArgumentList.Add(configuration.BaseDirectory);
            start.ArgumentList.Add("--no-browser");
        }
        start.Environment["T3CODE_HOME"] = configuration.BaseDirectory;
        start.Environment["PATH"] = $"{Path.GetDirectoryName(configuration.NodePath)};{start.Environment["PATH"]}";

        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, eventArgs) => LogChildLine(log, configuration.Mode, eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => LogChildLine(log, configuration.Mode, eventArgs.Data);
        if (!process.Start())
        {
            throw new InvalidOperationException("The T3 Code server process did not start.");
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static void LogChildLine(RotatingLog log, string source, string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        var trimmed = line.Trim();
        if (trimmed.StartsWith("Token:", StringComparison.OrdinalIgnoreCase) ||
            trimmed.StartsWith("Pairing URL:", StringComparison.OrdinalIgnoreCase))
        {
            log.Write($"[{source}] {trimmed.Split(':', 2)[0]}: [redacted]");
            return;
        }
        log.Write($"[{source}] {trimmed}");
    }

    private static async Task<bool> WaitForReady(
        Process process,
        Uri healthUrl,
        RotatingLog log,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + StartupTimeout;
        while (DateTimeOffset.UtcNow < deadline && !process.HasExited)
        {
            if (await IsHealthy(healthUrl, cancellationToken))
            {
                log.Write($"Server PID {process.Id} is ready.");
                return true;
            }
            await Task.Delay(TimeSpan.FromSeconds(3), cancellationToken);
        }
        if (process.HasExited)
        {
            log.Write($"Server PID {process.Id} exited during startup with code {process.ExitCode}.");
        }
        return false;
    }

    private static async Task MonitorHealthyServer(
        Process process,
        Uri healthUrl,
        RotatingLog log,
        CancellationToken cancellationToken)
    {
        var failedChecks = 0;
        var previousCpu = process.TotalProcessorTime;
        long? unhealthySince = null;

        while (!process.HasExited)
        {
            await Task.Delay(HealthInterval, cancellationToken);
            if (await IsHealthy(healthUrl, cancellationToken))
            {
                if (failedChecks > 0)
                {
                    log.Write($"Server PID {process.Id} recovered after {failedChecks} failed health check(s).");
                }
                failedChecks = 0;
                unhealthySince = null;
                previousCpu = process.TotalProcessorTime;
                continue;
            }

            if (process.HasExited) break;
            unhealthySince ??= Stopwatch.GetTimestamp();
            if (Stopwatch.GetElapsedTime(unhealthySince.Value) >= TimeSpan.FromMinutes(5))
            {
                log.Write($"Server PID {process.Id} has failed health checks for five minutes and will be restarted.");
                return;
            }
            process.Refresh();
            var currentCpu = process.TotalProcessorTime;
            var cpuDelta = currentCpu - previousCpu;
            previousCpu = currentCpu;
            if (cpuDelta >= TimeSpan.FromMilliseconds(500))
            {
                failedChecks = 0;
                log.Write($"Server PID {process.Id} missed a health check but remains CPU-active.");
                continue;
            }

            failedChecks++;
            log.Write($"Server PID {process.Id} failed health check {failedChecks}/{FailedHealthChecksBeforeRestart}.");
            if (failedChecks >= FailedHealthChecksBeforeRestart)
            {
                log.Write($"Server PID {process.Id} is unresponsive and will be restarted.");
                return;
            }
        }

        log.Write($"Server PID {process.Id} exited with code {process.ExitCode}.");
    }

    private static async Task<bool> IsHealthy(Uri healthUrl, CancellationToken cancellationToken)
    {
        using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        requestTimeout.CancelAfter(HealthTimeout);
        try
        {
            using var client = new HttpClient(new SocketsHttpHandler
            {
                ConnectTimeout = TimeSpan.FromSeconds(3),
                PooledConnectionLifetime = TimeSpan.FromSeconds(30),
            });
            using var response = await client.GetAsync(healthUrl, HttpCompletionOption.ResponseHeadersRead, requestTimeout.Token);
            return response.StatusCode == HttpStatusCode.OK;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    private static async Task StopServer(Process process, RotatingLog log)
    {
        if (process.HasExited)
        {
            return;
        }
        try
        {
            process.Kill(entireProcessTree: true);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await process.WaitForExitAsync(timeout.Token);
            log.Write($"Stopped server PID {process.Id}.");
        }
        catch (Exception error)
        {
            log.Write($"Failed to stop server PID {process.Id}: {error.Message}");
        }
    }
}

internal sealed record Configuration(
    string NodePath,
    string ServerEntryPath,
    string WorkingDirectory,
    string BaseDirectory,
    Uri HealthUrl,
    string LogDirectory,
    string Mode)
{
    public static Configuration Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length || !args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Arguments must use --name value pairs.");
            }
            values[args[index][2..]] = args[index + 1];
        }

        string Required(string name)
        {
            if (!values.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentException($"Missing --{name}.");
            }
            return Path.GetFullPath(value);
        }

        var node = Required("node");
        var server = Required("server");
        var workingDirectory = Required("workdir");
        var baseDirectory = Required("base-dir");
        var logDirectory = Required("log-dir");
        if (!File.Exists(node)) throw new FileNotFoundException("Node executable not found.", node);
        if (!File.Exists(server)) throw new FileNotFoundException("T3 Code server entry not found.", server);
        if (!Directory.Exists(workingDirectory)) throw new DirectoryNotFoundException(workingDirectory);
        if (!values.TryGetValue("health-url", out var healthValue) ||
            !Uri.TryCreate(healthValue, UriKind.Absolute, out var healthUrl))
        {
            throw new ArgumentException("Missing or invalid --health-url.");
        }

        var mode = values.GetValueOrDefault("mode", "server").Trim().ToLowerInvariant();
        if (mode is not ("server" or "web"))
        {
            throw new ArgumentException("--mode must be server or web.");
        }

        return new Configuration(node, server, workingDirectory, baseDirectory, healthUrl, logDirectory, mode);
    }
}

internal sealed class RotatingLog : IDisposable
{
    private const long MaximumBytes = 10 * 1024 * 1024;
    private readonly string path;
    private readonly object gate = new();
    private StreamWriter writer;

    public RotatingLog(string path)
    {
        this.path = path;
        writer = Open();
    }

    public void Write(string message)
    {
        lock (gate)
        {
            if (writer.BaseStream.Length >= MaximumBytes)
            {
                Rotate();
            }
            writer.WriteLine($"{DateTimeOffset.Now:O} {message}");
            writer.Flush();
        }
    }

    private StreamWriter Open() => new(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
    {
        AutoFlush = true,
    };

    private void Rotate()
    {
        writer.Dispose();
        for (var index = 2; index >= 1; index--)
        {
            var source = $"{path}.{index}";
            var destination = $"{path}.{index + 1}";
            if (File.Exists(destination)) File.Delete(destination);
            if (File.Exists(source)) File.Move(source, destination);
        }
        if (File.Exists($"{path}.1")) File.Delete($"{path}.1");
        if (File.Exists(path)) File.Move(path, $"{path}.1");
        writer = Open();
    }

    public void Dispose()
    {
        lock (gate)
        {
            writer.Dispose();
        }
    }
}

internal sealed class WindowsJob : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    // Lets a child that explicitly asks to break away (CREATE_BREAKAWAY_FROM_JOB)
    // outlive the server. The Codex desktop daemon is started that way and must
    // survive T3 restarts; ordinary children still die with the job.
    private const uint JobObjectLimitBreakawayOk = 0x00000800;
    private readonly IntPtr handle;

    private WindowsJob(IntPtr handle) => this.handle = handle;

    public static WindowsJob CreateKillOnClose(RotatingLog log)
    {
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero)
        {
            log.Write($"Could not create process job: Windows error {Marshal.GetLastWin32Error()}.");
            return new WindowsJob(IntPtr.Zero);
        }

        var information = new JobObjectExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags =
            JobObjectLimitKillOnJobClose | JobObjectLimitBreakawayOk;
        var length = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(handle, 9, pointer, (uint)length))
            {
                log.Write($"Could not configure process job: Windows error {Marshal.GetLastWin32Error()}.");
                CloseHandle(handle);
                return new WindowsJob(IntPtr.Zero);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return new WindowsJob(handle);
    }

    public void TryAssign(Process process, RotatingLog log)
    {
        if (handle != IntPtr.Zero && !AssignProcessToJobObject(handle, process.Handle))
        {
            log.Write($"Could not attach server PID {process.Id} to process job: Windows error {Marshal.GetLastWin32Error()}.");
        }
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero) CloseHandle(handle);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
