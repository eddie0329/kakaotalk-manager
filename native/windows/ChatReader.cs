// Read-only UI Automation provider. No focus, input, clipboard, scrolling, or window mutations.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public sealed class ReplyNode {
    public string id, parent, type, className, name, text;
    public double left, top, width, height;
    public bool textPattern, valuePattern, password;
}
public sealed class ReplyCapture {
    public string status = "ok";
    public string[] rooms = new string[0];
    public List<ReplyNode> nodes = new List<ReplyNode>();
    public bool minimized, truncated;
}
public static class ReplyWindowsReader {
    private delegate bool WindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    private static string Identity(AutomationElement element) { return String.Join(".", element.GetRuntimeId()); }
    private static bool Expired(Stopwatch clock, ReplyCapture result) {
        if (clock.ElapsedMilliseconds < 8000 && result.nodes.Count < 1200) return false;
        result.truncated = true; return true;
    }
    private static void Walk(AutomationElement element, string parent, ReplyCapture result, Stopwatch clock, int depth) {
        if (Expired(clock, result) || depth > 24) { result.truncated = true; return; }
        var info = element.Current;
        var rect = info.BoundingRectangle;
        var node = new ReplyNode {
            id = Identity(element), parent = parent, type = info.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            className = info.ClassName ?? "", name = info.IsPassword ? "" : (info.Name ?? ""), text = "",
            left = rect.IsEmpty ? 0 : rect.Left, top = rect.IsEmpty ? 0 : rect.Top,
            width = rect.IsEmpty ? 0 : rect.Width, height = rect.IsEmpty ? 0 : rect.Height, password = info.IsPassword,
            textPattern = (bool)element.GetCurrentPropertyValue(AutomationElement.IsTextPatternAvailableProperty),
            valuePattern = (bool)element.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty)
        };
        if (node.name.Length > 20000) { result.truncated = true; return; }
        // Never read the compose field / password / arbitrary window text as a transcript.
        if (!node.password && node.textPattern && node.type == "Document") {
            object pattern;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                node.text = ((TextPattern)pattern).DocumentRange.GetText(20001) ?? "";
            if (node.text.Length > 20000) { result.truncated = true; return; }
        }
        result.nodes.Add(node);
        var children = new List<AutomationElement>();
        var walker = TreeWalker.ControlViewWalker;
        var child = walker.GetFirstChild(element);
        while (child != null) {
            if (Expired(clock, result)) return;
            if (children.Count >= 2000) { result.truncated = true; return; }
            children.Add(child); child = walker.GetNextSibling(child);
        }
        // Virtualized lists expose only their loaded children; never realize or scroll more history.
        int start = (node.type == "List" || node.type == "DataGrid" || node.type == "Table") ? Math.Max(0, children.Count - 60) : 0;
        for (int i = start; i < children.Count; i++) {
            if (Expired(clock, result)) return;
            Walk(children[i], node.id, result, clock, depth + 1);
        }
    }
    public static ReplyCapture Capture(string operation, string room) {
        var result = new ReplyCapture();
        var clock = Stopwatch.StartNew();
        try {
            var pids = new HashSet<uint>();
            foreach (var process in Process.GetProcessesByName("KakaoTalk")) {
                using (process) { pids.Add((uint)process.Id); }
            }
            if (pids.Count == 0) { result.status = "not_running"; return result; }
            var windows = new List<AutomationElement>();
            var handles = new List<IntPtr>();
            EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
                if (clock.ElapsedMilliseconds >= 8000) { result.truncated = true; return false; }
                uint pid; GetWindowThreadProcessId(handle, out pid);
                if (!pids.Contains(pid)) return true;
                try {
                    var element = AutomationElement.FromHandle(handle);
                    var title = element.Current.Name;
                    if (!String.IsNullOrWhiteSpace(title) && title != "카카오톡" && title != "KakaoTalk" && title.Length <= 200) {
                        windows.Add(element); handles.Add(handle);
                    }
                } catch (ElementNotAvailableException) { }
                return true;
            }, IntPtr.Zero);
            var titles = new List<string>();
            foreach (var window in windows) { var title = window.Current.Name; if (!titles.Contains(title)) titles.Add(title); }
            result.rooms = titles.ToArray();
            if (operation == "list") return result;
            int selected = -1;
            for (int i = 0; i < windows.Count; i++) {
                if (windows[i].Current.Name != room) continue;
                if (selected >= 0) { result.status = "ambiguous_room"; return result; }
                selected = i;
            }
            if (selected < 0) { result.status = "room_closed"; return result; }
            result.minimized = IsIconic(handles[selected]);
            if (!result.minimized) Walk(windows[selected], "", result, clock, 0);
        } catch {
            // Native exceptions can contain application text. Return only a stable error category.
            result.status = "error"; result.nodes.Clear();
        }
        return result;
    }
}
