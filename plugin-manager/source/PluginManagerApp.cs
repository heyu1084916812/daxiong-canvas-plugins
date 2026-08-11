using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class PluginManagerProgram
{
    [STAThread]
    private static void Main(string[] args)
    {
        int port = 3000;
        foreach (string arg in args)
        {
            if (!arg.StartsWith("--port=", StringComparison.OrdinalIgnoreCase)) continue;
            int parsed;
            if (int.TryParse(arg.Substring(7), out parsed) && parsed > 0 && parsed < 65536) port = parsed;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PluginManagerForm(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), port));
    }
}

internal static class UiShapes
{
    internal static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
    {
        int diameter = Math.Max(2, radius * 2);
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}

internal sealed class RoundedPanel : Panel
{
    internal int Radius = 14;
    internal Color BorderColor = Color.Transparent;

    internal RoundedPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
    }

    protected override void OnResize(EventArgs eventArgs)
    {
        base.OnResize(eventArgs);
        if (Width < 2 || Height < 2) return;
        using (GraphicsPath path = UiShapes.RoundedRectangle(new Rectangle(0, 0, Width, Height), Radius))
        {
            Region old = Region;
            Region = new Region(path);
            if (old != null) old.Dispose();
        }
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        base.OnPaint(eventArgs);
        if (BorderColor == Color.Transparent) return;
        eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (GraphicsPath path = UiShapes.RoundedRectangle(new Rectangle(1, 1, Width - 3, Height - 3), Radius - 1))
        using (Pen pen = new Pen(BorderColor)) eventArgs.Graphics.DrawPath(pen, path);
    }
}

internal static class WindowEffects
{
    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        internal int AccentState;
        internal int AccentFlags;
        internal int GradientColor;
        internal int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttributeData
    {
        internal int Attribute;
        internal IntPtr Data;
        internal int SizeOfData;
    }

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr window, ref WindowCompositionAttributeData data);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);

    internal static void Enable(IntPtr window, bool dark)
    {
        try
        {
            int backdrop = 3;
            DwmSetWindowAttribute(window, 38, ref backdrop, sizeof(int));
            int darkMode = dark ? 1 : 0;
            DwmSetWindowAttribute(window, 20, ref darkMode, sizeof(int));
            int rounded = 2;
            DwmSetWindowAttribute(window, 33, ref rounded, sizeof(int));
        }
        catch { }
    }
}

internal sealed class RoundedButton : Button
{
    internal int Radius = 9;

    protected override void OnResize(EventArgs eventArgs)
    {
        base.OnResize(eventArgs);
        if (Width < 2 || Height < 2) return;
        using (GraphicsPath path = UiShapes.RoundedRectangle(new Rectangle(0, 0, Width, Height), Radius))
        {
            Region old = Region;
            Region = new Region(path);
            if (old != null) old.Dispose();
        }
    }
}

internal sealed class SlideToggle : Control
{
    private readonly System.Windows.Forms.Timer animationTimer;
    private float position;
    private float target;
    private bool isChecked;

    internal event EventHandler ToggleChanged;
    internal bool Checked { get { return isChecked; } }
    internal bool DarkMode { get; set; }

    internal SlideToggle()
    {
        Size = new Size(48, 26);
        Cursor = Cursors.Hand;
        TabStop = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
        BackColor = Color.Transparent;
        animationTimer = new System.Windows.Forms.Timer { Interval = 15 };
        animationTimer.Tick += Animate;
    }

    internal void SetChecked(bool value)
    {
        animationTimer.Stop();
        isChecked = value;
        target = position = value ? 1F : 0F;
        Invalidate();
    }

    protected override void OnClick(EventArgs eventArgs)
    {
        base.OnClick(eventArgs);
        if (!Enabled || animationTimer.Enabled) return;
        target = isChecked ? 0F : 1F;
        animationTimer.Start();
    }

    protected override void OnKeyDown(KeyEventArgs eventArgs)
    {
        if (eventArgs.KeyCode == Keys.Space || eventArgs.KeyCode == Keys.Enter)
        {
            OnClick(EventArgs.Empty);
            eventArgs.Handled = true;
        }
        base.OnKeyDown(eventArgs);
    }

    private void Animate(object sender, EventArgs eventArgs)
    {
        float direction = target > position ? 1F : -1F;
        position += direction * 0.22F;
        if ((direction > 0 && position >= target) || (direction < 0 && position <= target))
        {
            position = target;
            animationTimer.Stop();
            isChecked = target > 0.5F;
            EventHandler changed = ToggleChanged;
            if (changed != null) changed(this, EventArgs.Empty);
        }
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        base.OnPaint(eventArgs);
        eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Color offTrack = DarkMode ? Color.FromArgb(100, 116, 139) : Color.FromArgb(203, 213, 225);
        Color onTrack = DarkMode ? Color.FromArgb(248, 250, 252) : Color.FromArgb(17, 24, 39);
        Color track = Blend(offTrack, onTrack, position);
        if (!Enabled) track = DarkMode ? Color.FromArgb(51, 65, 85) : Color.FromArgb(226, 232, 240);
        Rectangle trackBounds = new Rectangle(0, 1, Width - 1, Height - 2);
        using (GraphicsPath path = UiShapes.RoundedRectangle(trackBounds, trackBounds.Height / 2))
        using (SolidBrush brush = new SolidBrush(track)) eventArgs.Graphics.FillPath(brush, path);
        using (Pen border = new Pen(position > 0.5F ? onTrack : offTrack))
        using (GraphicsPath path = UiShapes.RoundedRectangle(trackBounds, trackBounds.Height / 2)) eventArgs.Graphics.DrawPath(border, path);

        int knobSize = Height - 8;
        float left = 4F + position * (Width - knobSize - 8F);
        Color knob = DarkMode && position > 0.5F ? Color.FromArgb(15, 23, 42) : Color.White;
        if (!Enabled) knob = DarkMode ? Color.FromArgb(148, 163, 184) : Color.FromArgb(246, 248, 248);
        using (SolidBrush brush = new SolidBrush(knob)) eventArgs.Graphics.FillEllipse(brush, left, 4, knobSize, knobSize);
    }

    private static Color Blend(Color start, Color end, float amount)
    {
        return Color.FromArgb(
            (int)(start.R + (end.R - start.R) * amount),
            (int)(start.G + (end.G - start.G) * amount),
            (int)(start.B + (end.B - start.B) * amount));
    }
}

internal sealed class PluginManagerForm : Form
{
    private readonly string baseDir;
    private readonly int port;
    private readonly string apiRoot;
    private readonly FlowLayoutPanel cards;
    private readonly Label installedValue;
    private readonly Label enabledValue;
    private readonly Label issuesValue;
    private readonly Label coreVersionLabel;
    private readonly Label status;
    private readonly Button installButton;
    private readonly Button checkUpdatesButton;
    private readonly Button rescanButton;
    private readonly Button detectVersionButton;
    private readonly Button themeButton;
    private readonly System.Windows.Forms.Timer startupTimer;
    private readonly string themePath;
    private readonly Dictionary<Control, Color> lightBackColors = new Dictionary<Control, Color>();
    private readonly Dictionary<Control, Color> lightForeColors = new Dictionary<Control, Color>();
    private readonly Dictionary<RoundedPanel, Color> lightBorderColors = new Dictionary<RoundedPanel, Color>();
    private Dictionary<string, object> currentSnapshot;
    private bool darkTheme;
    private int startupAttempts;

    internal PluginManagerForm(string baseDir, int port)
    {
        this.baseDir = baseDir;
        this.port = port;
        apiRoot = "http://127.0.0.1:" + port + "/api/plugin-manager";
        themePath = Path.Combine(baseDir, "data", "plugin-manager-theme.txt");
        try { darkTheme = File.Exists(themePath) && File.ReadAllText(themePath).Trim().Equals("dark", StringComparison.OrdinalIgnoreCase); }
        catch { darkTheme = false; }
        Text = "大雄插件管理";
        try
        {
            Icon applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (applicationIcon != null) Icon = applicationIcon;
        }
        catch { }
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(650, 500);
        Size = new Size(760, 540);
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new Font("Microsoft YaHei UI", 9F);
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

        RoundedPanel header = new RoundedPanel { Dock = DockStyle.Top, Height = 88, Radius = 24, BackColor = Color.FromArgb(92, 255, 255, 255) };
        Label title = new Label { AutoSize = true, Location = new Point(22, 13), Text = "大雄插件管理", Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold), ForeColor = Color.FromArgb(17, 24, 39), BackColor = Color.Transparent };
        Label subtitle = new Label { AutoSize = true, Location = new Point(24, 49), Text = "轻量桌面版 · 轻松管理你的画布插件", Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Regular), ForeColor = Color.FromArgb(100, 116, 139), BackColor = Color.Transparent };
        themeButton = MakeButton("☾", Color.FromArgb(241, 245, 249), Color.FromArgb(17, 24, 39));
        themeButton.Size = new Size(34, 34);
        themeButton.Location = new Point(174, 14);
        ((RoundedButton)themeButton).Radius = 17;
        themeButton.Font = new Font("Segoe UI Symbol", 11F, FontStyle.Regular);
        themeButton.Click += delegate { ToggleTheme(); };
        installButton = MakeButton("安装 ZIP", Color.FromArgb(17, 24, 39), Color.White);
        installButton.Click += delegate { InstallPlugin(); };
        checkUpdatesButton = MakeButton("检查更新", Color.FromArgb(17, 24, 39), Color.White);
        checkUpdatesButton.Click += delegate { CheckPluginUpdates(); };
        rescanButton = MakeButton("重新扫描", Color.FromArgb(241, 245, 249), Color.FromArgb(17, 24, 39));
        rescanButton.Click += delegate { Rescan(); };
        detectVersionButton = MakeButton("检测版本", Color.FromArgb(241, 245, 249), Color.FromArgb(17, 24, 39));
        detectVersionButton.Click += delegate { DetectCoreVersion(); };
        FlowLayoutPanel headerActions = new FlowLayoutPanel
        {
            Dock = DockStyle.Right, Width = 480, Padding = new Padding(8, 26, 8, 0),
            FlowDirection = FlowDirection.LeftToRight, WrapContents = false, BackColor = Color.Transparent
        };
        installButton.Margin = new Padding(3, 0, 8, 0);
        checkUpdatesButton.Margin = new Padding(3, 0, 8, 0);
        rescanButton.Margin = new Padding(3, 0, 8, 0);
        detectVersionButton.Margin = new Padding(3, 0, 0, 0);
        headerActions.Controls.Add(installButton);
        headerActions.Controls.Add(checkUpdatesButton);
        headerActions.Controls.Add(detectVersionButton);
        headerActions.Controls.Add(rescanButton);
        header.Controls.Add(title); header.Controls.Add(subtitle); header.Controls.Add(themeButton); header.Controls.Add(headerActions);

        Panel info = new Panel { Dock = DockStyle.Top, Height = 62, BackColor = Color.Transparent };
        RoundedPanel installedBlock = CreateStatBlock("已安装", Color.FromArgb(241, 245, 249), out installedValue);
        RoundedPanel enabledBlock = CreateStatBlock("已启用", Color.FromArgb(241, 245, 249), out enabledValue);
        RoundedPanel issuesBlock = CreateStatBlock("需处理", Color.FromArgb(241, 245, 249), out issuesValue);
        installedBlock.Location = new Point(18, 8);
        enabledBlock.Location = new Point(130, 8);
        issuesBlock.Location = new Point(242, 8);
        coreVersionLabel = new Label { Location = new Point(365, 8), Size = new Size(170, 44), TextAlign = ContentAlignment.MiddleLeft, Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Regular), ForeColor = Color.FromArgb(100, 116, 139), BackColor = Color.Transparent };
        status = new Label { Dock = DockStyle.Right, Width = 190, Padding = new Padding(0, 0, 18, 0), TextAlign = ContentAlignment.MiddleRight, Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Bold), ForeColor = Color.FromArgb(17, 24, 39), BackColor = Color.Transparent };
        info.Controls.Add(installedBlock); info.Controls.Add(enabledBlock); info.Controls.Add(issuesBlock); info.Controls.Add(coreVersionLabel); info.Controls.Add(status);

        cards = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, WrapContents = false, FlowDirection = FlowDirection.TopDown, Padding = new Padding(12, 6, 8, 12), BackColor = Color.Transparent };
        cards.SizeChanged += delegate { ResizeCards(); };
        Controls.Add(cards); Controls.Add(info); Controls.Add(header);

        startupTimer = new System.Windows.Forms.Timer { Interval = 500 };
        startupTimer.Tick += CheckStartup;
        Shown += delegate { ConnectOrStart(); };
        ApplyThemeTree(this);
    }

    protected override void OnHandleCreated(EventArgs eventArgs)
    {
        base.OnHandleCreated(eventArgs);
        WindowEffects.Enable(Handle, darkTheme);
    }

    private void ToggleTheme()
    {
        darkTheme = !darkTheme;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(themePath));
            File.WriteAllText(themePath, darkTheme ? "dark" : "light", Encoding.UTF8);
        }
        catch { }
        ApplyThemeTree(this);
        WindowEffects.Enable(Handle, darkTheme);
        Invalidate(true);
    }

    private void ApplyThemeTree(Control control)
    {
        if (!lightBackColors.ContainsKey(control)) lightBackColors[control] = control.BackColor;
        if (!lightForeColors.ContainsKey(control)) lightForeColors[control] = control.ForeColor;
        Color lightBack = lightBackColors[control];
        Color lightFore = lightForeColors[control];
        control.BackColor = darkTheme ? DarkBack(lightBack) : lightBack;
        control.ForeColor = darkTheme ? DarkFore(lightFore, lightBack) : lightFore;
        RoundedPanel panel = control as RoundedPanel;
        if (panel != null)
        {
            if (!lightBorderColors.ContainsKey(panel)) lightBorderColors[panel] = panel.BorderColor;
            panel.BorderColor = darkTheme ? DarkBorder(lightBorderColors[panel]) : lightBorderColors[panel];
        }
        SlideToggle slide = control as SlideToggle;
        if (slide != null) slide.DarkMode = darkTheme;
        foreach (Control child in control.Controls) ApplyThemeTree(child);
        if (control == themeButton) themeButton.Text = darkTheme ? "☀" : "☾";
        control.Invalidate();
    }

    private static bool SameRgb(Color color, int red, int green, int blue)
    {
        return color.R == red && color.G == green && color.B == blue;
    }

    private static Color DarkBack(Color light)
    {
        if (light.A == 0) return Color.Transparent;
        if (SameRgb(light, 248, 250, 252)) return Color.FromArgb(light.A, 11, 16, 32);
        if (SameRgb(light, 241, 245, 249)) return Color.FromArgb(light.A, 30, 41, 59);
        if (SameRgb(light, 17, 24, 39)) return Color.FromArgb(light.A, 248, 250, 252);
        if (SameRgb(light, 255, 255, 255)) return light.A >= 180 ? Color.FromArgb(light.A, 15, 23, 42) : Color.FromArgb(light.A, 17, 24, 39);
        return Color.FromArgb(light.A, 38, 52, 73);
    }

    private static Color DarkFore(Color lightFore, Color lightBack)
    {
        if (lightFore.A == 0) return Color.Transparent;
        if (SameRgb(lightBack, 17, 24, 39) && SameRgb(lightFore, 255, 255, 255)) return Color.FromArgb(lightFore.A, 15, 23, 42);
        if (SameRgb(lightFore, 17, 24, 39)) return Color.FromArgb(lightFore.A, 248, 250, 252);
        if (SameRgb(lightFore, 100, 116, 139) || SameRgb(lightFore, 71, 85, 105)) return Color.FromArgb(lightFore.A, 203, 213, 225);
        if (SameRgb(lightFore, 148, 163, 184)) return Color.FromArgb(lightFore.A, 148, 163, 184);
        if (SameRgb(lightFore, 255, 255, 255)) return Color.FromArgb(lightFore.A, 248, 250, 252);
        return Color.FromArgb(lightFore.A, 203, 213, 225);
    }

    private static Color DarkBorder(Color light)
    {
        if (light.A == 0) return Color.Transparent;
        return Color.FromArgb(light.A, 51, 65, 85);
    }

    private void SetLightFore(Control control, Color color)
    {
        lightForeColors[control] = color;
        Color lightBack = lightBackColors.ContainsKey(control) ? lightBackColors[control] : control.BackColor;
        control.ForeColor = darkTheme ? DarkFore(color, lightBack) : color;
    }

    private void SetLightBack(Control control, Color color)
    {
        lightBackColors[control] = color;
        control.BackColor = darkTheme ? DarkBack(color) : color;
    }

    private static Button MakeButton(string text, Color back, Color fore)
    {
        RoundedButton button = new RoundedButton { Text = text, Size = new Size(112, 34), Radius = 17, FlatStyle = FlatStyle.Flat, BackColor = back, ForeColor = fore, Cursor = Cursors.Hand, TabStop = false };
        button.FlatAppearance.BorderSize = 0;
        return button;
    }

    private RoundedPanel CreateStatBlock(string caption, Color tint, out Label value)
    {
        RoundedPanel block = new RoundedPanel { Size = new Size(104, 46), Radius = 16, BackColor = tint };
        Label captionLabel = new Label { Text = caption, Location = new Point(12, 6), Size = new Size(80, 16), Font = new Font("Microsoft YaHei UI", 8F, FontStyle.Regular), ForeColor = Color.FromArgb(100, 116, 139), BackColor = Color.Transparent };
        value = new Label { Text = "0", Location = new Point(12, 20), Size = new Size(80, 21), Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold), ForeColor = Color.FromArgb(17, 24, 39), BackColor = Color.Transparent };
        block.Controls.Add(captionLabel); block.Controls.Add(value);
        return block;
    }

    private void ConnectOrStart()
    {
        SetBusy("正在连接后台服务…");
        if (EndpointReady()) { LoadPlugins(); return; }
        string mode;
        string detail;
        if (!TryStartBackend(out mode, out detail))
        {
            ShowError("无法启动后台服务。\n" + detail + "\n\n可用方式：\n1) 大雄无限画布.exe\n2) python\\python.exe + plugin_host.py\n3) start.bat / run.bat");
            return;
        }
        SetBusy("正在启动后台服务（" + mode + "）…");
        startupAttempts = 0;
        startupTimer.Start();
    }

    private bool TryStartBackend(out string mode, out string detail)
    {
        mode = "";
        detail = "";
        Exception last = null;

        string exeLauncher = Path.Combine(baseDir, "大雄无限画布.exe");
        if (File.Exists(exeLauncher))
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = exeLauncher,
                    Arguments = "--no-browser --port=" + port,
                    WorkingDirectory = baseDir,
                    UseShellExecute = true
                });
                mode = "大雄无限画布.exe";
                return true;
            }
            catch (Exception ex) { last = ex; }
        }

        string bundledPython = Path.Combine(baseDir, "python", "python.exe");
        string hostScript = Path.Combine(baseDir, "plugin_host.py");
        if (File.Exists(hostScript))
        {
            string[] pythonCandidates = File.Exists(bundledPython)
                ? new string[] { bundledPython, "py", "python" }
                : new string[] { "py", "python" };
            foreach (string python in pythonCandidates)
            {
                try
                {
                    ProcessStartInfo info = new ProcessStartInfo();
                    info.WorkingDirectory = baseDir;
                    info.UseShellExecute = false;
                    info.CreateNoWindow = true;
                    try { info.EnvironmentVariables["INFINITE_CANVAS_PORT"] = port.ToString(); } catch { }
                    if (string.Equals(python, "py", StringComparison.OrdinalIgnoreCase))
                    {
                        info.FileName = "py";
                        info.Arguments = "-3 \"" + hostScript + "\"";
                    }
                    else if (string.Equals(python, "python", StringComparison.OrdinalIgnoreCase))
                    {
                        info.FileName = "python";
                        info.Arguments = "\"" + hostScript + "\"";
                    }
                    else
                    {
                        info.FileName = python;
                        info.Arguments = "\"" + hostScript + "\"";
                    }
                    Process.Start(info);
                    mode = File.Exists(bundledPython) && string.Equals(python, bundledPython, StringComparison.OrdinalIgnoreCase)
                        ? "plugin_host.py (内置 Python)"
                        : "plugin_host.py (" + python + ")";
                    return true;
                }
                catch (Exception ex) { last = ex; }
            }
        }

        string[] batNames = new string[] { "start.bat", "run.bat" };
        foreach (string batName in batNames)
        {
            string bat = Path.Combine(baseDir, batName);
            if (!File.Exists(bat)) continue;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = bat,
                    WorkingDirectory = baseDir,
                    UseShellExecute = true
                });
                mode = batName;
                return true;
            }
            catch (Exception ex) { last = ex; }
        }

        System.Text.StringBuilder sb = new System.Text.StringBuilder();
        sb.AppendLine("当前目录未找到可用启动入口。");
        sb.AppendLine("已检查：大雄无限画布.exe / python\\python.exe + plugin_host.py / start.bat / run.bat");
        if (last != null) sb.AppendLine("最后错误：" + last.Message);
        detail = sb.ToString().TrimEnd();
        return false;
    }

    private void CheckStartup(object sender, EventArgs e)
    {
        startupAttempts++;
        if (EndpointReady()) { startupTimer.Stop(); LoadPlugins(); }
        else if (startupAttempts >= 60)
        {
            startupTimer.Stop();
            ShowError("后台服务在 30 秒内没有准备完成。\n请先手动运行 start.bat、run.bat 或 大雄无限画布.exe，确认服务可访问后再打开插件管理器。");
        }
    }

    private bool EndpointReady()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(apiRoot + "/plugins");
            request.Timeout = 400;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private void LoadPlugins()
    {
        try
        {
            SetBusy("正在读取插件并检查更新…");
            Dictionary<string, object> data;
            try { data = ApiJson("GET", "/updates"); }
            catch { data = ApiJson("GET", "/plugins"); }
            Render(data);
            string count = ValueText(data, "compatible_update_count");
            string availableCount = ValueText(data, "available_count");
            SetReady(count.Length > 0 && count != "0" ? "发现 " + count + " 个可用更新" : (availableCount.Length > 0 && availableCount != "0" ? "仓库有 " + availableCount + " 个插件可安装" : "已连接 · 端口 " + port));
        }
        catch (Exception ex) { ShowError("插件列表读取失败：" + ex.Message); }
    }

    private void Render(Dictionary<string, object> data)
    {
        currentSnapshot = data;
        cards.SuspendLayout(); cards.Controls.Clear();
        object rawPlugins;
        object[] plugins = data.TryGetValue("plugins", out rawPlugins) ? rawPlugins as object[] : null;
        if (plugins == null) plugins = new object[0];
        object rawAvailable;
        object[] availablePlugins = data.TryGetValue("available_plugins", out rawAvailable) ? rawAvailable as object[] : null;
        if (availablePlugins == null) availablePlugins = new object[0];
        foreach (object item in plugins.Concat(availablePlugins))
        {
            Dictionary<string, object> plugin = item as Dictionary<string, object>;
            if (plugin == null) continue;
            cards.Controls.Add(CreateCard(plugin));
        }
        RefreshSummary();
        if (plugins.Length == 0 && availablePlugins.Length == 0) cards.Controls.Add(new Label { Text = "还没有安装插件。点击右上角“安装 ZIP 插件”开始使用。", AutoSize = false, Size = new Size(720, 100), TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.FromArgb(110, 120, 137), Font = new Font(Font, FontStyle.Italic) });
        ResizeCards(); cards.ResumeLayout(); ApplyThemeTree(cards);
    }

    private Control CreateCard(Dictionary<string, object> plugin)
    {
        RoundedPanel card = new RoundedPanel { Width = CardWidth(), Height = 138, Radius = 22, BorderColor = Color.FromArgb(110, 255, 255, 255), Margin = new Padding(5), Padding = new Padding(16), BackColor = Color.FromArgb(205, 255, 255, 255), Tag = plugin };
        Label name = new Label { Text = ValueText(plugin, "name"), AutoEllipsis = true, Location = new Point(18, 12), Size = new Size(card.Width - 205, 25), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, Font = new Font("Microsoft YaHei UI", 11.5F, FontStyle.Bold), ForeColor = Color.FromArgb(17, 24, 39), BackColor = Color.Transparent };
        bool hasUpdate = Bool(plugin, "update_available");
        bool updateCompatible = Bool(plugin, "update_compatible");
        bool installed = Bool(plugin, "installed");
        string updateMeta = hasUpdate ? "  ·  最新 v" + ValueText(plugin, "latest_version") + (updateCompatible ? "" : "（不兼容）") : "";
        Label meta = new Label { Text = "v" + ValueText(plugin, "version") + updateMeta + "  ·  " + (ValueText(plugin, "author").Length > 0 ? ValueText(plugin, "author") : "未知作者"), Location = new Point(18, 38), Size = new Size(card.Width - 205, 18), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, Font = new Font("Microsoft YaHei UI", 8.3F, FontStyle.Regular), ForeColor = hasUpdate && updateCompatible ? Color.FromArgb(37, 99, 235) : Color.FromArgb(148, 163, 184), BackColor = Color.Transparent };
        Label description = new Label { Text = ValueText(plugin, "description").Length > 0 ? ValueText(plugin, "description") : "该插件没有填写说明。", Location = new Point(18, 65), Size = new Size(card.Width - 36, 20), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, Font = new Font("Microsoft YaHei UI", 8.8F, FontStyle.Regular), ForeColor = Color.FromArgb(71, 85, 105), AutoEllipsis = true, BackColor = Color.Transparent };
        bool enabled = Bool(plugin, "enabled");
        bool available = installed && Bool(plugin, "manifest_valid") && Bool(plugin, "compatible") && Bool(plugin, "backend_registered");
        RoundedPanel toggleBlock = new RoundedPanel { Location = new Point(card.Width - 158, 10), Size = new Size(140, 42), Anchor = AnchorStyles.Top | AnchorStyles.Right, Radius = 15, BorderColor = Color.FromArgb(100, 255, 255, 255), BackColor = Color.FromArgb(235, 241, 245, 249), Visible = installed };
        Label toggleLabel = new Label { Text = enabled ? "已启用" : "已停用", TextAlign = ContentAlignment.MiddleLeft, Location = new Point(12, 8), Size = new Size(64, 26), Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Bold), ForeColor = enabled ? Color.FromArgb(17, 24, 39) : Color.FromArgb(100, 116, 139), BackColor = Color.Transparent };
        SlideToggle toggle = new SlideToggle { Location = new Point(81, 8), Enabled = available };
        toggle.SetChecked(enabled);
        string healthText = HealthText(plugin);
        RoundedPanel healthBlock = new RoundedPanel { Location = new Point(18, 94), Size = new Size(122, 30), Radius = 12, BorderColor = Color.FromArgb(90, 255, 255, 255), BackColor = HealthBackground(healthText) };
        Label health = new Label { Text = healthText, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Bold), ForeColor = HealthForeground(healthText), BackColor = Color.Transparent };
        RoundedPanel actionBlock = new RoundedPanel { Location = new Point(card.Width - 362, 91), Size = new Size(344, 36), Anchor = AnchorStyles.Top | AnchorStyles.Right, Radius = 14, BackColor = Color.FromArgb(95, 255, 255, 255) };
        FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(4, 3, 4, 0), FlowDirection = FlowDirection.RightToLeft, WrapContents = false, BackColor = Color.Transparent };
        if (!installed)
        {
            Button repositoryInstall = ActionButton(Bool(plugin, "install_compatible") ? "一键安装" : "当前版本不兼容", delegate { InstallFromRepository(plugin); });
            repositoryInstall.Enabled = Bool(plugin, "install_compatible");
            actions.Controls.Add(repositoryInstall);
        }
        else
        {
            Button healthButton = ActionButton("健康检查", delegate { ShowHealth(plugin); });
            Button logsButton = ActionButton("查看日志", delegate { ShowLogs(plugin); });
            Button upgradeButton = hasUpdate && updateCompatible
                ? ActionButton("一键更新", delegate { UpdateFromRepository(plugin); })
                : ActionButton("升级 ZIP", delegate { Upgrade(plugin); });
            Button remove = ActionButton("卸载", delegate { Uninstall(plugin); }); remove.ForeColor = Color.FromArgb(17, 24, 39);
            actions.Controls.Add(healthButton); actions.Controls.Add(logsButton); actions.Controls.Add(upgradeButton); actions.Controls.Add(remove);
        }
        toggle.ToggleChanged += delegate { ToggleInline(plugin, toggle, toggleLabel, health); };
        toggleBlock.Controls.Add(toggleLabel); toggleBlock.Controls.Add(toggle);
        healthBlock.Controls.Add(health);
        actionBlock.Controls.Add(actions);
        card.Controls.Add(name); card.Controls.Add(meta); card.Controls.Add(description); card.Controls.Add(healthBlock); card.Controls.Add(toggleBlock); card.Controls.Add(actionBlock);
        return card;
    }

    private Button ActionButton(string text, EventHandler click)
    {
        RoundedButton button = new RoundedButton { Text = text, AutoSize = true, Height = 29, Radius = 14, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(241, 245, 249), ForeColor = Color.FromArgb(17, 24, 39), Font = new Font("Microsoft YaHei UI", 8.3F, FontStyle.Regular), Cursor = Cursors.Hand };
        button.FlatAppearance.BorderSize = 0; button.Click += click; return button;
    }

    private string HealthText(Dictionary<string, object> plugin)
    {
        if (!Bool(plugin, "installed")) return Bool(plugin, "install_compatible") ? "仓库可安装" : "当前版本不兼容";
        if (!Bool(plugin, "manifest_valid")) return "异常 · 插件清单错误";
        if (!Bool(plugin, "compatible")) return "异常 · " + ValueText(plugin, "reason");
        if (!Bool(plugin, "enabled")) return "已停用";
        if (!Bool(plugin, "backend_registered")) return "异常 · 后台加载失败";
        string health = ValueText(plugin, "health");
        if (health == "healthy") return "正常运行";
        if (health == "ok") return "正常";
        return health.Length > 0 ? "状态 · " + health : "状态未知";
    }

    private static Color HealthBackground(string healthText)
    {
        if (healthText.StartsWith("正常")) return Color.FromArgb(241, 245, 249);
        if (healthText == "已停用") return Color.FromArgb(241, 245, 249);
        return Color.FromArgb(241, 245, 249);
    }

    private static Color HealthForeground(string healthText)
    {
        if (healthText.StartsWith("正常")) return Color.FromArgb(17, 24, 39);
        if (healthText == "已停用") return Color.FromArgb(100, 116, 139);
        return Color.FromArgb(100, 116, 139);
    }

    private void ToggleInline(Dictionary<string, object> plugin, SlideToggle toggle, Label toggleLabel, Label health)
    {
        bool enable = toggle.Checked;
        toggle.Enabled = false;
        status.Text = "正在" + (enable ? "启用" : "停用") + "插件…";
        SetLightFore(status, Color.FromArgb(100, 116, 139));
        try
        {
            Dictionary<string, object> response = ApiJson("POST", "/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "/" + (enable ? "enable" : "disable"));
            object raw;
            Dictionary<string, object> updated = response.TryGetValue("plugin", out raw) ? raw as Dictionary<string, object> : null;
            if (updated != null)
            {
                plugin.Clear();
                foreach (KeyValuePair<string, object> item in updated) plugin[item.Key] = item.Value;
            }
            else plugin["enabled"] = enable;
            toggleLabel.Text = enable ? "已启用" : "已停用";
            SetLightFore(toggleLabel, enable ? Color.FromArgb(17, 24, 39) : Color.FromArgb(100, 116, 139));
            if (toggleLabel.Parent != null) SetLightBack(toggleLabel.Parent, Color.FromArgb(235, 241, 245, 249));
            string healthText = HealthText(plugin);
            health.Text = healthText;
            SetLightFore(health, HealthForeground(healthText));
            if (health.Parent != null) SetLightBack(health.Parent, HealthBackground(healthText));
            RefreshSummary();
            SetReady((enable ? "启用" : "停用") + "插件完成");
        }
        catch (Exception ex)
        {
            toggle.SetChecked(!enable);
            ShowError((enable ? "启用" : "停用") + "插件失败：" + ex.Message);
        }
        finally
        {
            toggle.Enabled = Bool(plugin, "manifest_valid") && Bool(plugin, "compatible") && Bool(plugin, "backend_registered");
        }
    }

    private void RefreshSummary()
    {
        if (currentSnapshot == null) return;
        object raw;
        object[] plugins = currentSnapshot.TryGetValue("plugins", out raw) ? raw as object[] : null;
        if (plugins == null) plugins = new object[0];
        int enabled = 0, errors = 0;
        foreach (object item in plugins)
        {
            Dictionary<string, object> plugin = item as Dictionary<string, object>;
            if (plugin == null) continue;
            if (Bool(plugin, "enabled")) enabled++;
            if (!Bool(plugin, "manifest_valid") || !Bool(plugin, "compatible") || ValueText(plugin, "error_message").Length > 0) errors++;
        }
        installedValue.Text = plugins.Length.ToString();
        enabledValue.Text = enabled.ToString();
        issuesValue.Text = errors.ToString();
        coreVersionLabel.Text = "核心版本\n" + ValueText(currentSnapshot, "core_version");
    }
    private void Rescan() { RunAction("重新扫描插件", delegate { ApiJson("POST", "/rescan"); }); }
    private void CheckPluginUpdates()
    {
        try
        {
            SetBusy("正在检查插件更新…");
            Dictionary<string, object> data = ApiJson("POST", "/updates/check");
            Render(data);
            string count = ValueText(data, "compatible_update_count");
            string availableCount = ValueText(data, "available_count");
            SetReady(count.Length > 0 && count != "0" ? "发现 " + count + " 个可用更新" : (availableCount.Length > 0 && availableCount != "0" ? "仓库有 " + availableCount + " 个插件可安装" : "所有插件均为最新版"));
        }
        catch (Exception ex) { ShowError("检查更新失败：" + ex.Message); }
    }
    private void DetectCoreVersion()
{
    RunAction("检测画布版本", delegate
    {
        Dictionary<string, object> result = null;
        string usedPath = "local";
        Exception last = null;
        string[][] attempts = new string[][] {
            new string[] { "POST", "/rescan" },
            new string[] { "GET", "/plugins" },
            new string[] { "POST", "/core-version/detect" },
            new string[] { "GET", "/core-version" }
        };
        foreach (string[] item in attempts)
        {
            try
            {
                result = ApiJson(item[0], item[1]);
                usedPath = item[0] + " " + item[1];
                last = null;
                break;
            }
            catch (Exception ex) { last = ex; }
        }

        LocalVersionInfo local = InspectLocalVersions();
        string core = result != null ? ValueText(result, "core_version") : "";
        string prev = "";
        string fileVer = local.VersionFile;
        string mainVer = local.MainAppVersion;
        string latestBackup = local.LatestBackupVersion;
        string backupCount = local.BackupCount.ToString();
        string staleCount = local.StaleBackupCount.ToString();

        object versionObj;
        Dictionary<string, object> version = null;
        if (result != null)
        {
            if (result.TryGetValue("version", out versionObj)) version = versionObj as Dictionary<string, object>;
            if (version == null && result.TryGetValue("core_version_info", out versionObj)) version = versionObj as Dictionary<string, object>;
        }
        if (version != null)
        {
            prev = ValueText(version, "previous_core_version");
            object sourcesObj;
            Dictionary<string, object> sources = null;
            if (version.TryGetValue("sources", out sourcesObj)) sources = sourcesObj as Dictionary<string, object>;
            if (sources != null)
            {
                string apiFile = ValueText(sources, "version_file");
                string apiMain = ValueText(sources, "main_app_version");
                string apiBackup = ValueText(sources, "latest_backup_version");
                string apiBackupCount = ValueText(sources, "backup_count");
                string apiStale = ValueText(sources, "stale_backup_count");
                if (!string.IsNullOrWhiteSpace(apiFile)) fileVer = apiFile;
                if (!string.IsNullOrWhiteSpace(apiMain)) mainVer = apiMain;
                if (!string.IsNullOrWhiteSpace(apiBackup)) latestBackup = apiBackup;
                if (!string.IsNullOrWhiteSpace(apiBackupCount)) backupCount = apiBackupCount;
                if (!string.IsNullOrWhiteSpace(apiStale)) staleCount = apiStale;
            }
            if (string.IsNullOrWhiteSpace(core)) core = ValueText(version, "core_version");
        }

        string bound = PickLatestVersion(new string[] { core, fileVer, mainVer, local.EffectiveVersion });
        if (string.IsNullOrWhiteSpace(bound)) bound = "-";

        int incompatible = 0;
        object listObj;
        if (result != null && result.TryGetValue("incompatible_plugins", out listObj))
        {
            System.Collections.IList list = listObj as System.Collections.IList;
            if (list != null) incompatible = list.Count;
        }
        else if (result != null && result.TryGetValue("plugins", out listObj))
        {
            object[] plugins = listObj as object[];
            if (plugins != null)
            {
                foreach (object item in plugins)
                {
                    Dictionary<string, object> plugin = item as Dictionary<string, object>;
                    if (plugin == null) continue;
                    object compatibleObj;
                    if (plugin.TryGetValue("compatible", out compatibleObj))
                    {
                        if (compatibleObj is bool && !(bool)compatibleObj) incompatible++;
                        else if (compatibleObj != null && string.Equals(compatibleObj.ToString(), "False", StringComparison.OrdinalIgnoreCase)) incompatible++;
                    }
                }
            }
        }

        BeginInvoke(new Action(delegate
        {
            if (coreVersionLabel != null) coreVersionLabel.Text = "核心版本\n" + bound;
        }));

        object refreshedPlugins;
        if (result != null && result.TryGetValue("plugins", out refreshedPlugins))
            Render(result);

        string msg =
            "当前绑定核心版本：" + bound + "\r\n" +
            "接口返回版本：" + (string.IsNullOrWhiteSpace(core) ? "-" : core) + "\r\n" +
            "检测前版本：" + (string.IsNullOrWhiteSpace(prev) ? "-" : prev) + "\r\n" +
            "VERSION 文件：" + (string.IsNullOrWhiteSpace(fileVer) ? "-" : fileVer) + "\r\n" +
            "main.py APP_VERSION：" + (string.IsNullOrWhiteSpace(mainVer) ? "-" : mainVer) + "\r\n" +
            "备份中的旧 VERSION 数：" + backupCount + "\r\n" +
            "其中低于当前版本：" + staleCount + "\r\n" +
            "备份里最高旧版本：" + (string.IsNullOrWhiteSpace(latestBackup) ? "-" : latestBackup) + "\r\n" +
            "不兼容插件数：" + incompatible + "\r\n" +
            "使用接口：" + usedPath + "\r\n\r\n" +
            "说明：\r\n" +
            "1) data\\update_backups 里的旧 VERSION 只是历史备份，不会作为当前版本。\r\n" +
            "2) 系统始终绑定最新有效版本（VERSION / main.py）。\r\n" +
            "3) 若插件仍显示不兼容，请重启画布服务后再点“重新扫描”。";
        if (last != null && result == null)
            throw new InvalidOperationException(last.Message);
        MessageBox.Show(this, msg, "画布版本检测", MessageBoxButtons.OK, MessageBoxIcon.Information);
    });
}

private sealed class LocalVersionInfo
{
    internal string VersionFile = "";
    internal string MainAppVersion = "";
    internal string LatestBackupVersion = "";
    internal string EffectiveVersion = "";
    internal int BackupCount = 0;
    internal int StaleBackupCount = 0;
}

private string ReadFirstLine(string path)
{
    if (!File.Exists(path)) return "";
    try
    {
        string text = File.ReadAllText(path, Encoding.UTF8).Trim();
        if (string.IsNullOrWhiteSpace(text)) return "";
        return text.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)[0].Trim();
    }
    catch { return ""; }
}

private int[] VersionKey(string value)
{
    System.Collections.Generic.List<int> parts = new System.Collections.Generic.List<int>();
    if (string.IsNullOrWhiteSpace(value)) return new int[] { 0 };
    System.Text.RegularExpressions.MatchCollection matches = System.Text.RegularExpressions.Regex.Matches(value, "\\d+");
    foreach (System.Text.RegularExpressions.Match m in matches)
    {
        int n;
        if (int.TryParse(m.Value, out n)) parts.Add(n);
    }
    if (parts.Count == 0) parts.Add(0);
    return parts.ToArray();
}

private int CompareVersion(string left, string right)
{
    int[] ka = VersionKey(left);
    int[] kb = VersionKey(right);
    int n = Math.Max(ka.Length, kb.Length);
    for (int i = 0; i < n; i++)
    {
        int x = i < ka.Length ? ka[i] : 0;
        int y = i < kb.Length ? kb[i] : 0;
        if (x != y) return x.CompareTo(y);
    }
    return 0;
}

private string PickLatestVersion(string[] values)
{
    string best = "";
    foreach (string raw in values)
    {
        string value = raw == null ? "" : raw.Trim();
        if (string.IsNullOrWhiteSpace(value)) continue;
        if (string.IsNullOrWhiteSpace(best) || CompareVersion(value, best) > 0) best = value;
    }
    return best;
}

private LocalVersionInfo InspectLocalVersions()
{
    LocalVersionInfo info = new LocalVersionInfo();
    info.VersionFile = ReadFirstLine(Path.Combine(baseDir, "VERSION"));
    try
    {
        string mainPath = Path.Combine(baseDir, "main.py");
        if (File.Exists(mainPath))
        {
            string mainText = File.ReadAllText(mainPath, Encoding.UTF8);
            if (mainText.Length > 8000) mainText = mainText.Substring(0, 8000);
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(mainText, "APP_VERSION\\s*=\\s*['\"]([^'\"]+)['\"]");
            if (m.Success) info.MainAppVersion = m.Groups[1].Value.Trim();
        }
    }
    catch { }

    string backupRoot = Path.Combine(baseDir, "data", "update_backups");
    System.Collections.Generic.List<string> backups = new System.Collections.Generic.List<string>();
    try
    {
        if (Directory.Exists(backupRoot))
        {
            string[] dirs = Directory.GetDirectories(backupRoot);
            Array.Sort(dirs);
            Array.Reverse(dirs);
            int limit = Math.Min(dirs.Length, 100);
            for (int i = 0; i < limit; i++)
            {
                string ver = ReadFirstLine(Path.Combine(dirs[i], "VERSION"));
                if (!string.IsNullOrWhiteSpace(ver)) backups.Add(ver);
            }
        }
    }
    catch { }
    info.BackupCount = backups.Count;
    info.LatestBackupVersion = PickLatestVersion(backups.ToArray());
    info.EffectiveVersion = PickLatestVersion(new string[] { info.VersionFile, info.MainAppVersion });
    foreach (string ver in backups)
    {
        if (!string.IsNullOrWhiteSpace(info.EffectiveVersion) && CompareVersion(ver, info.EffectiveVersion) < 0)
            info.StaleBackupCount++;
    }
    return info;
}
    private void InstallPlugin() { string path = PickZip("选择要安装的插件 ZIP"); if (path != null) RunAction("安装插件", delegate { Upload("/install", path); }); }
    private void Upgrade(Dictionary<string, object> plugin) { string path = PickZip("选择 " + ValueText(plugin, "name") + " 的升级 ZIP"); if (path != null) RunAction("升级插件", delegate { Upload("/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "/upgrade", path); }); }
    private void UpdateFromRepository(Dictionary<string, object> plugin)
    {
        string name = ValueText(plugin, "name");
        string latest = ValueText(plugin, "latest_version");
        if (MessageBox.Show("将“" + name + "”更新到 v" + latest + "。\n\n更新包会先校验，插件数据会保留。是否继续？", "一键更新", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        Dictionary<string, object> result = null;
        RunAction("更新 " + name, delegate { result = ApiJson("POST", "/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "/update-from-repository"); });
        if (result == null) return;
        if (Bool(result, "restart_required"))
            MessageBox.Show(this, "更新完成。该插件包含后端功能，请重启大雄画布后生效。", "插件更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
        else if (Bool(result, "refresh_required"))
            MessageBox.Show(this, "更新完成。刷新画布页面后生效。", "插件更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
    private void InstallFromRepository(Dictionary<string, object> plugin)
    {
        string name = ValueText(plugin, "name");
        string version = ValueText(plugin, "version");
        if (MessageBox.Show("将从插件仓库安装“" + name + "”v" + version + "。\n\n安装包会先完成安全和兼容性校验。是否继续？", "一键安装", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        Dictionary<string, object> result = null;
        RunAction("安装 " + name, delegate { result = ApiJson("POST", "/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "/install-from-repository"); });
        if (result != null) MessageBox.Show(this, "安装完成。刷新画布后即可使用；如果插件包含后端功能，建议重启一次大雄画布。", "插件安装", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void ShowHealth(Dictionary<string, object> plugin)
    {
        try { Dictionary<string, object> result = ApiJson("GET", "/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "/health"); ShowDetails(ValueText(plugin, "name") + " · 健康检查", Pretty(result)); LoadPlugins(); }
        catch (Exception ex) { ShowError(ex.Message); }
    }

    private void ShowLogs(Dictionary<string, object> plugin)
    {
        try
        {
            Dictionary<string, object> result = ApiJson("GET", "/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "/logs");
            object raw; object[] lines = result.TryGetValue("lines", out raw) ? raw as object[] : null; StringBuilder value = new StringBuilder();
            if (lines != null) foreach (object line in lines) value.AppendLine(Convert.ToString(line));
            ShowDetails(ValueText(plugin, "name") + " · 日志", value.Length > 0 ? value.ToString() : "暂无日志");
        }
        catch (Exception ex) { ShowError(ex.Message); }
    }

    private void Uninstall(Dictionary<string, object> plugin)
    {
        string name = ValueText(plugin, "name");
        if (MessageBox.Show("确定卸载“" + name + "”吗？\n\n默认保留插件产生的数据。", "卸载插件", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        bool deleteData = MessageBox.Show("是否同时删除“" + name + "”的插件数据？\n\n选择“否”可保留数据，方便以后重新安装。", "插件数据", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
        RunAction("卸载插件", delegate { ApiJson("DELETE", "/" + Uri.EscapeDataString(ValueText(plugin, "id")) + "?delete_data=" + deleteData.ToString().ToLowerInvariant()); });
    }

    private void RunAction(string label, Action action)
    {
        try { SetBusy(label + "…"); action(); LoadPlugins(); SetReady(label + "完成"); }
        catch (Exception ex) { SetReady("操作失败"); ShowError(label + "失败：" + ex.Message); }
    }

    private string PickZip(string title)
    {
        using (OpenFileDialog dialog = new OpenFileDialog { Title = title, Filter = "插件压缩包 (*.zip)|*.zip", CheckFileExists = true }) return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null;
    }

    private Dictionary<string, object> ApiJson(string method, string path)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(apiRoot + path);
        request.Method = method;
        request.Timeout = 30000;
        // GET must not force ContentLength; some servers return Method Not Allowed.
        if (!string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
            request.ContentLength = 0;
        try { using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return Parse(reader.ReadToEnd()); }
        catch (WebException ex) { throw new InvalidOperationException(ReadWebError(ex), ex); }
    }

    private Dictionary<string, object> Upload(string path, string filePath)
    {
        string boundary = "----InfiniteCanvas" + DateTime.Now.Ticks.ToString("x");
        byte[] header = Encoding.UTF8.GetBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + Path.GetFileName(filePath).Replace("\"", "") + "\"\r\nContent-Type: application/zip\r\n\r\n");
        byte[] footer = Encoding.ASCII.GetBytes("\r\n--" + boundary + "--\r\n"); FileInfo file = new FileInfo(filePath);
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(apiRoot + path); request.Method = "POST"; request.ContentType = "multipart/form-data; boundary=" + boundary; request.ContentLength = header.Length + file.Length + footer.Length; request.Timeout = 120000;
        try
        {
            using (Stream output = request.GetRequestStream()) { output.Write(header, 0, header.Length); using (FileStream input = File.OpenRead(filePath)) input.CopyTo(output); output.Write(footer, 0, footer.Length); }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return Parse(reader.ReadToEnd());
        }
        catch (WebException ex) { throw new InvalidOperationException(ReadWebError(ex), ex); }
    }

    private static Dictionary<string, object> Parse(string json) { return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.DeserializeObject(json) as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    private static string ReadWebError(WebException ex)
    {
        try { if (ex.Response == null) return ex.Message; using (StreamReader reader = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8)) { Dictionary<string, object> value = Parse(reader.ReadToEnd()); string detail = ValueText(value, "detail"); return detail.Length > 0 ? detail : ex.Message; } }
        catch { return ex.Message; }
    }
    private static string Pretty(object value) { return new JavaScriptSerializer().Serialize(value).Replace(",\"", ",\r\n\"").Replace("{\"", "{\r\n\"").Replace("}", "\r\n}"); }
    private void ShowDetails(string title, string value) { Form dialog = new Form { Text = title, StartPosition = FormStartPosition.CenterParent, Size = new Size(720, 480), MinimizeBox = false, MaximizeBox = false }; TextBox box = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Font = new Font("Consolas", 10F), Text = value }; dialog.Controls.Add(box); dialog.ShowDialog(this); }
    private static string ValueText(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw) : ""; }
    private static bool Bool(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null && Convert.ToBoolean(raw); }
    private int CardWidth() { return Math.Max(590, cards.ClientSize.Width - 38); }
    private void ResizeCards() { int width = CardWidth(); foreach (Control control in cards.Controls) if (control is Panel) control.Width = width; }
    private void SetBusy(string message) { installButton.Enabled = false; checkUpdatesButton.Enabled = false; rescanButton.Enabled = false; status.Text = message; SetLightFore(status, Color.FromArgb(100, 116, 139)); UseWaitCursor = true; }
    private void SetReady(string message) { installButton.Enabled = true; checkUpdatesButton.Enabled = true; rescanButton.Enabled = true; status.Text = message; SetLightFore(status, Color.FromArgb(17, 24, 39)); UseWaitCursor = false; }
    private void ShowError(string message) { SetReady("连接或操作失败"); MessageBox.Show(this, message, "大雄插件管理", MessageBoxButtons.OK, MessageBoxIcon.Error); }
}
