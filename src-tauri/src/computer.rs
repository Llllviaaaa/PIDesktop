use std::io::{self, Read};
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use uiautomation::patterns::{
    UIInvokePattern, UIScrollItemPattern, UISelectionItemPattern, UITogglePattern, UIValuePattern,
};
use uiautomation::types::Handle;
use uiautomation::{UIAutomation, UIElement};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window as CaptureWindow;
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    SRCCOPY,
};
use windows_sys::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, IsWindowVisible, SetCursorPos, SetForegroundWindow, ShowWindowAsync,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    action: String,
    x: Option<i32>,
    y: Option<i32>,
    end_x: Option<i32>,
    end_y: Option<i32>,
    delta_x: Option<i32>,
    delta_y: Option<i32>,
    duration_ms: Option<u64>,
    button: Option<String>,
    count: Option<u32>,
    text: Option<String>,
    key: Option<String>,
    window_title: Option<String>,
    #[serde(rename = "ref")]
    target_ref: Option<String>,
    max_elements: Option<usize>,
    actions: Option<Vec<Request>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    data: String,
    mime_type: &'static str,
    width: i32,
    height: i32,
    left: i32,
    top: i32,
    image_width: u32,
    image_height: u32,
    scale_x: f64,
    scale_y: f64,
    capture_backend: &'static str,
    frame_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_fallback: Option<String>,
}

struct RawFrame {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    left: i32,
    top: i32,
}

#[derive(Clone)]
struct WgcCaptureFlags {
    output: Arc<Mutex<WgcCaptureState>>,
    expected_width: u32,
    expected_height: u32,
}

#[derive(Default)]
struct WgcCaptureState {
    latest: Option<RawFrame>,
    frames_seen: u32,
}

struct SingleFrameCapture {
    flags: WgcCaptureFlags,
}

impl GraphicsCaptureApiHandler for SingleFrameCapture {
    type Flags = WgcCaptureFlags;
    type Error = String;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            flags: context.flags,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let width = frame.width();
        let height = frame.height();
        if width == 0 || height == 0 {
            return Err("Windows Graphics Capture returned an empty frame".to_string());
        }
        let frame_buffer = frame
            .buffer()
            .map_err(|err| format!("Could not map the Windows Graphics Capture frame: {err}"))?;
        let mut unpadded = Vec::new();
        let bgra = frame_buffer.as_nopadding_buffer(&mut unpadded).to_vec();
        let mut output = self
            .flags
            .output
            .lock()
            .map_err(|_| "Windows Graphics Capture output lock was poisoned".to_string())?;
        output.frames_seen += 1;
        output.latest = Some(RawFrame {
            bgra,
            width,
            height,
            left: 0,
            top: 0,
        });
        if (width == self.flags.expected_width && height == self.flags.expected_height)
            || output.frames_seen >= 2
        {
            capture_control.stop();
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ElementBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ElementInfo {
    #[serde(rename = "ref")]
    target_ref: String,
    role: String,
    name: String,
    value: Option<String>,
    bounds: ElementBounds,
    enabled: bool,
    focused: bool,
    focusable: bool,
    patterns: Vec<&'static str>,
}

#[derive(Serialize)]
struct WindowInfo {
    title: String,
    handle: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Capture(Capture),
    Windows {
        windows: Vec<WindowInfo>,
    },
    Observation {
        elements: Vec<ElementInfo>,
        #[serde(rename = "windowTitle")]
        window_title: String,
        #[serde(rename = "windowHandle")]
        window_handle: String,
    },
    Batch {
        ok: bool,
        completed: usize,
    },
    Ok {
        ok: bool,
    },
    Error {
        ok: bool,
        error: String,
    },
}

pub fn run() -> i32 {
    // Helper mode exits before Tauri initializes its normal DPI handling. Set it here so
    // screenshots and input coordinates use physical virtual-screen pixels on scaled displays.
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let result = read_request().and_then(handle);
    match result {
        Ok(response) => {
            println!(
                "{}",
                serde_json::to_string(&response).unwrap_or_else(|_| {
                    r#"{"ok":false,"error":"Could not serialize helper response"}"#.to_string()
                })
            );
            0
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string(&Response::Error { ok: false, error }).unwrap_or_else(|_| {
                    r#"{"ok":false,"error":"Computer helper failed"}"#.to_string()
                })
            );
            1
        }
    }
}

fn read_request() -> Result<Request, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| format!("Could not read helper request: {err}"))?;
    serde_json::from_str(&input).map_err(|err| format!("Invalid helper request: {err}"))
}

fn handle(request: Request) -> Result<Response, String> {
    match request.action.as_str() {
        "screenshot" => capture_screen(request.window_title.as_deref()).map(Response::Capture),
        "list_windows" => Ok(Response::Windows {
            windows: list_windows()?,
        }),
        "observe" => {
            let (elements, window_title, window_handle) = observe_elements(
                request.window_title.as_deref(),
                request.max_elements.unwrap_or(200).clamp(1, 500),
            )?;
            Ok(Response::Observation {
                elements,
                window_title,
                window_handle,
            })
        }
        "batch" => {
            let actions = request.actions.ok_or("batch requires actions")?;
            if actions.is_empty() || actions.len() > 20 {
                return Err("batch requires between 1 and 20 actions".to_string());
            }
            let total_duration = actions
                .iter()
                .filter(|action| action.action == "wait" || action.action == "drag")
                .map(|action| {
                    action
                        .duration_ms
                        .unwrap_or(if action.action == "wait" { 1_000 } else { 500 })
                })
                .fold(0_u64, u64::saturating_add);
            if total_duration > 30_000 {
                return Err("batch wait and drag duration must not exceed 30000ms".to_string());
            }
            let completed = actions.len();
            for (index, action) in actions.into_iter().enumerate() {
                if ["batch", "screenshot", "list_windows", "observe"]
                    .contains(&action.action.as_str())
                {
                    return Err(format!(
                        "batch action {} ({}) is not an atomic action",
                        index + 1,
                        action.action
                    ));
                }
                let name = action.action.clone();
                handle(action).map_err(|error| {
                    format!("batch action {} ({name}) failed: {error}", index + 1)
                })?;
            }
            Ok(Response::Batch {
                ok: true,
                completed,
            })
        }
        "focus_window" => {
            focus_window(request.window_title.as_deref().unwrap_or_default())?;
            Ok(Response::Ok { ok: true })
        }
        "click" | "double_click" => {
            click(
                request.x.ok_or("click requires x")?,
                request.y.ok_or("click requires y")?,
                request.button.as_deref().unwrap_or("left"),
                if request.action == "double_click" {
                    2
                } else {
                    request.count.unwrap_or(1).clamp(1, 2)
                },
            )?;
            Ok(Response::Ok { ok: true })
        }
        "move" => {
            move_pointer(
                request.x.ok_or("move requires x")?,
                request.y.ok_or("move requires y")?,
            )?;
            Ok(Response::Ok { ok: true })
        }
        "scroll" => {
            scroll(
                request.x,
                request.y,
                request.delta_x.unwrap_or_default(),
                request.delta_y.unwrap_or_default(),
            )?;
            Ok(Response::Ok { ok: true })
        }
        "drag" => {
            drag(
                request.x.ok_or("drag requires x")?,
                request.y.ok_or("drag requires y")?,
                request.end_x.ok_or("drag requires endX")?,
                request.end_y.ok_or("drag requires endY")?,
                request.duration_ms.unwrap_or(500).clamp(50, 5_000),
            )?;
            Ok(Response::Ok { ok: true })
        }
        "type" => {
            type_text(request.text.as_deref().ok_or("type requires text")?)?;
            Ok(Response::Ok { ok: true })
        }
        "key" | "keypress" => {
            press_combo(request.key.as_deref().ok_or("key requires key")?)?;
            Ok(Response::Ok { ok: true })
        }
        "wait" => {
            thread::sleep(Duration::from_millis(
                request.duration_ms.unwrap_or(1_000).clamp(0, 30_000),
            ));
            Ok(Response::Ok { ok: true })
        }
        "invoke" | "set_value" | "toggle" | "select" | "focus_element" | "scroll_element" => {
            perform_element_action(
                request.action.as_str(),
                request
                    .target_ref
                    .as_deref()
                    .ok_or("element action requires ref")?,
                request.text.as_deref(),
            )?;
            Ok(Response::Ok { ok: true })
        }
        _ => Err(format!("Unsupported computer action: {}", request.action)),
    }
}

fn capture_screen(window_title: Option<&str>) -> Result<Capture, String> {
    let virtual_left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    let window = window_title
        .filter(|title| !title.trim().is_empty())
        .map(find_window)
        .transpose()?;
    let mut capture_fallback = None;
    if let Some(window) = &window {
        let handle = window
            .handle
            .parse::<usize>()
            .map(|value| value as HWND)
            .map_err(|_| "Windows returned an invalid window handle".to_string())?;
        match capture_window_wgc(handle) {
            Ok(frame) => {
                return encode_capture(
                    &frame.bgra,
                    frame.width,
                    frame.height,
                    frame.left,
                    frame.top,
                    "wgc",
                    None,
                );
            }
            Err(error) => capture_fallback = Some(error),
        }
    }

    let (left, top, width, height) = if let Some(window) = &window {
        let right = (window.x + window.width).min(virtual_left + virtual_width);
        let bottom = (window.y + window.height).min(virtual_top + virtual_height);
        let left = window.x.max(virtual_left);
        let top = window.y.max(virtual_top);
        (left, top, right - left, bottom - top)
    } else {
        (virtual_left, virtual_top, virtual_width, virtual_height)
    };
    if width <= 0 || height <= 0 {
        return Err("Windows reported an invalid virtual-screen size".to_string());
    }

    let screen_dc = unsafe { GetDC(null_mut()) };
    if screen_dc.is_null() {
        return Err("Could not open the Windows screen device".to_string());
    }
    let memory_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if memory_dc.is_null() {
        unsafe { ReleaseDC(null_mut(), screen_dc) };
        return Err("Could not create a screen capture device".to_string());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
    if bitmap.is_null() {
        unsafe {
            DeleteDC(memory_dc);
            ReleaseDC(null_mut(), screen_dc);
        }
        return Err("Could not allocate the screen capture bitmap".to_string());
    }
    let previous = unsafe { SelectObject(memory_dc, bitmap) };
    let copied = unsafe {
        BitBlt(
            memory_dc,
            0,
            0,
            width,
            height,
            screen_dc,
            left,
            top,
            SRCCOPY | CAPTUREBLT,
        )
    };

    let mut info: BITMAPINFO = unsafe { zeroed() };
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..Default::default()
    };
    let mut bgra = vec![0_u8; width as usize * height as usize * 4];
    let scan_lines = if copied != 0 {
        unsafe {
            GetDIBits(
                memory_dc,
                bitmap,
                0,
                height as u32,
                bgra.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        }
    } else {
        0
    };
    unsafe {
        SelectObject(memory_dc, previous);
        DeleteObject(bitmap);
        DeleteDC(memory_dc);
        ReleaseDC(null_mut(), screen_dc);
    }
    if copied == 0 || scan_lines != height {
        return Err("Windows could not copy the desktop image".to_string());
    }

    encode_capture(
        &bgra,
        width as u32,
        height as u32,
        left,
        top,
        "gdi",
        capture_fallback,
    )
}

fn capture_window_wgc(handle: HWND) -> Result<RawFrame, String> {
    let bounds = window_capture_bounds(handle)?;
    let expected_width = (bounds.right - bounds.left)
        .try_into()
        .map_err(|_| "DWM returned an invalid window width".to_string())?;
    let expected_height = (bounds.bottom - bounds.top)
        .try_into()
        .map_err(|_| "DWM returned an invalid window height".to_string())?;
    let output = Arc::new(Mutex::new(WgcCaptureState::default()));
    let flags = WgcCaptureFlags {
        output: output.clone(),
        expected_width,
        expected_height,
    };
    let settings = Settings::new(
        CaptureWindow::from_raw_hwnd(handle),
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );
    let control = SingleFrameCapture::start_free_threaded(settings)
        .map_err(|err| format!("Windows Graphics Capture could not start: {err}"))?;
    let deadline = Instant::now() + Duration::from_millis(1_500);
    while Instant::now() < deadline {
        if control.is_finished() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    if control.is_finished() {
        control
            .wait()
            .map_err(|err| format!("Windows Graphics Capture ended unexpectedly: {err}"))?;
    } else {
        control
            .stop()
            .map_err(|err| format!("Windows Graphics Capture could not stop: {err}"))?;
    }
    let mut frame = output
        .lock()
        .map_err(|_| "Windows Graphics Capture output lock was poisoned".to_string())?
        .latest
        .take()
        .ok_or_else(|| "Windows Graphics Capture timed out waiting for a frame".to_string())?;
    frame.left = bounds.left;
    frame.top = bounds.top;
    Ok(frame)
}

fn window_capture_bounds(handle: HWND) -> Result<RECT, String> {
    let mut bounds: RECT = unsafe { zeroed() };
    let result = unsafe {
        DwmGetWindowAttribute(
            handle,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut bounds as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        )
    };
    if result < 0 || bounds.right <= bounds.left || bounds.bottom <= bounds.top {
        return Err(format!(
            "DWM could not provide capture-aligned window bounds (HRESULT 0x{:08x})",
            result as u32
        ));
    }
    Ok(bounds)
}

fn encode_capture(
    bgra: &[u8],
    width: u32,
    height: u32,
    left: i32,
    top: i32,
    capture_backend: &'static str,
    capture_fallback: Option<String>,
) -> Result<Capture, String> {
    if width == 0 || height == 0 {
        return Err("Windows reported an invalid capture size".to_string());
    }
    let expected_size = width as usize * height as usize * 4;
    if bgra.len() < expected_size {
        return Err(format!(
            "Windows returned an incomplete capture buffer: expected {expected_size}, got {}",
            bgra.len()
        ));
    }

    let scale = f64::min(1.0, f64::min(1600.0 / width as f64, 1000.0 / height as f64));
    let output_width = (width as f64 * scale).round().max(1.0) as u32;
    let output_height = (height as f64 * scale).round().max(1.0) as u32;
    let mut rgb = vec![0_u8; output_width as usize * output_height as usize * 3];
    for y in 0..output_height {
        let source_y = (y as u64 * u64::from(height) / u64::from(output_height)) as usize;
        for x in 0..output_width {
            let source_x = (x as u64 * u64::from(width) / u64::from(output_width)) as usize;
            let source = (source_y * width as usize + source_x) * 4;
            let target = (y as usize * output_width as usize + x as usize) * 3;
            rgb[target] = bgra[source + 2];
            rgb[target + 1] = bgra[source + 1];
            rgb[target + 2] = bgra[source];
        }
    }

    let mut png_data = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_data, output_width, output_height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder
            .write_header()
            .map_err(|err| format!("Could not initialize PNG encoder: {err}"))?;
        writer
            .write_image_data(&rgb)
            .map_err(|err| format!("Could not encode desktop screenshot: {err}"))?;
    }
    Ok(Capture {
        data: base64::engine::general_purpose::STANDARD.encode(png_data),
        mime_type: "image/png",
        width: width as i32,
        height: height as i32,
        left,
        top,
        image_width: output_width,
        image_height: output_height,
        scale_x: width as f64 / output_width as f64,
        scale_y: height as f64 / output_height as f64,
        capture_backend,
        frame_id: frame_id(&rgb),
        capture_fallback,
    })
}

fn frame_id(rgb: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in rgb {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn target_window(window_title: Option<&str>) -> Result<(HWND, String), String> {
    if let Some(title) = window_title.filter(|title| !title.trim().is_empty()) {
        let window = find_window(title)?;
        let handle = window
            .handle
            .parse::<usize>()
            .map(|value| value as HWND)
            .map_err(|_| "Windows returned an invalid window handle".to_string())?;
        return Ok((handle, window.title));
    }

    let handle = unsafe { GetForegroundWindow() };
    if handle.is_null() {
        return Err("Windows did not report a foreground window".to_string());
    }
    let handle_value = handle as usize;
    let title = list_windows()?
        .into_iter()
        .find(|window| window.handle.parse::<usize>().ok() == Some(handle_value))
        .map(|window| window.title)
        .unwrap_or_default();
    Ok((handle, title))
}

fn element_ref(handle: HWND, runtime_id: &[i32]) -> String {
    let runtime_id = runtime_id
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(".");
    format!("uia:{}:{runtime_id}", handle as usize)
}

fn element_info(handle: HWND, element: &UIElement) -> Option<ElementInfo> {
    if element.is_offscreen().unwrap_or(false) {
        return None;
    }
    let rect = element.get_bounding_rectangle().ok()?;
    let width = rect.get_right() - rect.get_left();
    let height = rect.get_bottom() - rect.get_top();
    if width <= 0 || height <= 0 {
        return None;
    }
    let runtime_id = element.get_runtime_id().ok()?;
    let name = element.get_name().unwrap_or_default();
    let role = element
        .get_localized_control_type()
        .unwrap_or_else(|_| "control".to_string());
    let invoke = element.get_pattern::<UIInvokePattern>().ok();
    let value_pattern = element.get_pattern::<UIValuePattern>().ok();
    let selection = element.get_pattern::<UISelectionItemPattern>().ok();
    let toggle = element.get_pattern::<UITogglePattern>().ok();
    let scroll_item = element.get_pattern::<UIScrollItemPattern>().ok();
    let mut patterns = Vec::new();
    if invoke.is_some() {
        patterns.push("invoke");
    }
    if value_pattern.is_some() {
        patterns.push("value");
    }
    if selection.is_some() {
        patterns.push("select");
    }
    if toggle.is_some() {
        patterns.push("toggle");
    }
    if scroll_item.is_some() {
        patterns.push("scroll");
    }
    let value = if element.is_password().unwrap_or(false) {
        None
    } else {
        value_pattern
            .and_then(|pattern| pattern.get_value().ok())
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(500).collect())
    };
    if name.is_empty() && value.is_none() && patterns.is_empty() {
        return None;
    }
    Some(ElementInfo {
        target_ref: element_ref(handle, &runtime_id),
        role,
        name,
        value,
        bounds: ElementBounds {
            x: rect.get_left(),
            y: rect.get_top(),
            width,
            height,
        },
        enabled: element.is_enabled().unwrap_or(false),
        focused: element.has_keyboard_focus().unwrap_or(false),
        focusable: element.is_keyboard_focusable().unwrap_or(false),
        patterns,
    })
}

fn walk_elements(
    automation: &UIAutomation,
    handle: HWND,
    root: UIElement,
    max_elements: usize,
) -> Result<Vec<ElementInfo>, String> {
    let walker = automation
        .get_control_view_walker()
        .map_err(|err| format!("Could not create UI Automation tree walker: {err}"))?;
    let mut elements = Vec::new();
    let mut stack = vec![(root, 0_usize)];
    let mut visited = 0_usize;
    while let Some((element, depth)) = stack.pop() {
        visited += 1;
        if visited > 4_000 || elements.len() >= max_elements {
            break;
        }
        if let Some(info) = element_info(handle, &element) {
            elements.push(info);
        }
        if depth >= 16 {
            continue;
        }
        let mut children = Vec::new();
        let mut child = walker.get_first_child(&element).ok();
        while let Some(current) = child {
            child = walker.get_next_sibling(&current).ok();
            children.push(current);
            if children.len() >= 1_000 {
                break;
            }
        }
        for child in children.into_iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    Ok(elements)
}

fn observe_elements(
    window_title: Option<&str>,
    max_elements: usize,
) -> Result<(Vec<ElementInfo>, String, String), String> {
    let (handle, title) = target_window(window_title)?;
    let automation = UIAutomation::new()
        .map_err(|err| format!("Could not initialize Windows UI Automation: {err}"))?;
    let root = automation
        .element_from_handle(Handle::from(handle as isize))
        .map_err(|err| format!("Could not inspect the target window: {err}"))?;
    let elements = walk_elements(&automation, handle, root, max_elements)?;
    Ok((elements, title, (handle as usize).to_string()))
}

fn parse_element_ref(target_ref: &str) -> Result<(HWND, Vec<i32>), String> {
    let mut parts = target_ref.splitn(3, ':');
    if parts.next() != Some("uia") {
        return Err("Unsupported element ref; take a fresh observation".to_string());
    }
    let handle = parts
        .next()
        .ok_or("Element ref is missing a window handle")?
        .parse::<usize>()
        .map(|value| value as HWND)
        .map_err(|_| "Element ref contains an invalid window handle".to_string())?;
    let runtime_id = parts
        .next()
        .ok_or("Element ref is missing a runtime id")?
        .split('.')
        .map(|part| {
            part.parse::<i32>()
                .map_err(|_| "Element ref contains an invalid runtime id".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((handle, runtime_id))
}

fn find_element(target_ref: &str) -> Result<UIElement, String> {
    let (handle, wanted_runtime_id) = parse_element_ref(target_ref)?;
    let automation = UIAutomation::new()
        .map_err(|err| format!("Could not initialize Windows UI Automation: {err}"))?;
    let root = automation
        .element_from_handle(Handle::from(handle as isize))
        .map_err(|err| format!("The referenced window is no longer available: {err}"))?;
    let walker = automation
        .get_control_view_walker()
        .map_err(|err| format!("Could not create UI Automation tree walker: {err}"))?;
    let mut stack = vec![(root, 0_usize)];
    let mut visited = 0_usize;
    while let Some((element, depth)) = stack.pop() {
        visited += 1;
        if visited > 8_000 {
            break;
        }
        if element.get_runtime_id().ok().as_deref() == Some(wanted_runtime_id.as_slice()) {
            return Ok(element);
        }
        if depth >= 20 {
            continue;
        }
        let mut children = Vec::new();
        let mut child = walker.get_first_child(&element).ok();
        while let Some(current) = child {
            child = walker.get_next_sibling(&current).ok();
            children.push(current);
            if children.len() >= 2_000 {
                break;
            }
        }
        for child in children.into_iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    Err("The UI element ref is stale; take a fresh observation".to_string())
}

fn perform_element_action(
    action: &str,
    target_ref: &str,
    text: Option<&str>,
) -> Result<(), String> {
    let element = find_element(target_ref)?;
    match action {
        "invoke" => match element.get_pattern::<UIInvokePattern>() {
            Ok(pattern) => pattern
                .invoke()
                .map_err(|err| format!("Could not invoke UI element: {err}")),
            Err(_) => {
                let point = element
                    .get_clickable_point()
                    .map_err(|err| {
                        format!("UI element has no invoke pattern or click point: {err}")
                    })?
                    .ok_or("UI element has no invoke pattern or click point")?;
                click(point.get_x(), point.get_y(), "left", 1)
            }
        },
        "set_value" => element
            .get_pattern::<UIValuePattern>()
            .map_err(|err| format!("UI element does not support setting a value: {err}"))?
            .set_value(text.ok_or("set_value requires text")?)
            .map_err(|err| format!("Could not set UI element value: {err}")),
        "toggle" => element
            .get_pattern::<UITogglePattern>()
            .map_err(|err| format!("UI element does not support toggle: {err}"))?
            .toggle()
            .map_err(|err| format!("Could not toggle UI element: {err}")),
        "select" => element
            .get_pattern::<UISelectionItemPattern>()
            .map_err(|err| format!("UI element does not support selection: {err}"))?
            .select()
            .map_err(|err| format!("Could not select UI element: {err}")),
        "focus_element" => element
            .set_focus()
            .map_err(|err| format!("Could not focus UI element: {err}")),
        "scroll_element" => element
            .get_pattern::<UIScrollItemPattern>()
            .map_err(|err| format!("UI element does not support scroll into view: {err}"))?
            .scroll_into_view()
            .map_err(|err| format!("Could not scroll UI element into view: {err}")),
        _ => Err(format!("Unsupported UI element action: {action}")),
    }
}

unsafe extern "system" fn enum_window(handle: HWND, parameter: LPARAM) -> BOOL {
    if IsWindowVisible(handle) == 0 {
        return 1;
    }
    let length = GetWindowTextLengthW(handle);
    if length <= 0 {
        return 1;
    }
    let mut title = vec![0_u16; length as usize + 1];
    if GetWindowTextW(handle, title.as_mut_ptr(), title.len() as i32) <= 0 {
        return 1;
    }
    let mut rect: RECT = zeroed();
    if GetWindowRect(handle, &mut rect) == 0 {
        return 1;
    }
    let windows = &mut *(parameter as *mut Vec<WindowInfo>);
    windows.push(WindowInfo {
        title: String::from_utf16_lossy(&title[..length as usize]),
        handle: (handle as usize).to_string(),
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    });
    1
}

fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let mut windows = Vec::new();
    let ok = unsafe {
        EnumWindows(
            Some(enum_window),
            (&mut windows as *mut Vec<WindowInfo>) as LPARAM,
        )
    };
    if ok == 0 {
        return Err("Windows could not enumerate desktop windows".to_string());
    }
    Ok(windows)
}

fn focus_window(fragment: &str) -> Result<(), String> {
    let window = find_window(fragment)?;
    let handle = window
        .handle
        .parse::<usize>()
        .map(|value| value as HWND)
        .map_err(|_| "Windows returned an invalid window handle".to_string())?;
    unsafe {
        ShowWindowAsync(handle, SW_RESTORE);
        if SetForegroundWindow(handle) == 0 {
            return Err("Windows did not allow that window to take focus".to_string());
        }
    }
    Ok(())
}

fn find_window(fragment: &str) -> Result<WindowInfo, String> {
    if fragment.trim().is_empty() {
        return Err("window title must not be empty".to_string());
    }
    let query = fragment.to_lowercase();
    list_windows()?
        .into_iter()
        .find(|window| window.title.to_lowercase().contains(&query))
        .ok_or_else(|| format!("No visible window matches: {fragment}"))
}

fn mouse_input(flags: u32, mouse_data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                mouseData: mouse_data,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn keyboard_input(key: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn submit(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent != inputs.len() as u32 {
        return Err(
            "Windows blocked synthetic input; the target may be elevated or protected".to_string(),
        );
    }
    Ok(())
}

fn click(x: i32, y: i32, button: &str, count: u32) -> Result<(), String> {
    move_pointer(x, y)?;
    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => return Err(format!("Unsupported mouse button: {button}")),
    };
    for _ in 0..count {
        submit(&[mouse_input(down, 0), mouse_input(up, 0)])?;
    }
    Ok(())
}

fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    if unsafe { SetCursorPos(x, y) } == 0 {
        return Err("Windows could not move the pointer".to_string());
    }
    Ok(())
}

fn scroll(x: Option<i32>, y: Option<i32>, delta_x: i32, delta_y: i32) -> Result<(), String> {
    match (x, y) {
        (Some(x), Some(y)) => move_pointer(x, y)?,
        (None, None) => {}
        _ => return Err("scroll requires both x and y when positioning the pointer".to_string()),
    }
    if delta_x == 0 && delta_y == 0 {
        return Err("scroll requires a non-zero deltaX or deltaY".to_string());
    }
    let mut inputs = Vec::with_capacity(2);
    if delta_y != 0 {
        // The tool protocol uses positive Y for scrolling down; Win32 uses positive for up.
        inputs.push(mouse_input(
            MOUSEEVENTF_WHEEL,
            delta_y.saturating_neg().clamp(-12_000, 12_000) as u32,
        ));
    }
    if delta_x != 0 {
        inputs.push(mouse_input(
            MOUSEEVENTF_HWHEEL,
            delta_x.clamp(-12_000, 12_000) as u32,
        ));
    }
    submit(&inputs)
}

fn drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    duration_ms: u64,
) -> Result<(), String> {
    move_pointer(start_x, start_y)?;
    submit(&[mouse_input(MOUSEEVENTF_LEFTDOWN, 0)])?;
    let steps = (duration_ms / 16).clamp(2, 120);
    for step in 1..=steps {
        let progress = step as f64 / steps as f64;
        let x = start_x + ((end_x - start_x) as f64 * progress).round() as i32;
        let y = start_y + ((end_y - start_y) as f64 * progress).round() as i32;
        if let Err(error) = move_pointer(x, y) {
            let _ = submit(&[mouse_input(MOUSEEVENTF_LEFTUP, 0)]);
            return Err(error);
        }
        thread::sleep(Duration::from_millis((duration_ms / steps).max(1)));
    }
    submit(&[mouse_input(MOUSEEVENTF_LEFTUP, 0)])
}

fn type_text(text: &str) -> Result<(), String> {
    for code_unit in text.encode_utf16() {
        submit(&[
            keyboard_input(0, code_unit, KEYEVENTF_UNICODE),
            keyboard_input(0, code_unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
        ])?;
    }
    Ok(())
}

fn press_combo(combo: &str) -> Result<(), String> {
    let parts = combo
        .split('+')
        .map(|part| part.trim().to_uppercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let (key_name, modifier_names) = parts
        .split_last()
        .ok_or_else(|| "Key combination is empty".to_string())?;
    let mut modifiers = Vec::new();
    for modifier in modifier_names {
        modifiers.push(match modifier.as_str() {
            "CTRL" | "CONTROL" => 0x11,
            "SHIFT" => 0x10,
            "ALT" => 0x12,
            "WIN" | "META" => 0x5B,
            _ => return Err(format!("Unsupported modifier: {modifier}")),
        });
    }
    let key = resolve_key(key_name)?;
    let mut inputs = Vec::new();
    for modifier in &modifiers {
        inputs.push(keyboard_input(*modifier, 0, 0));
    }
    inputs.push(keyboard_input(key, 0, 0));
    inputs.push(keyboard_input(key, 0, KEYEVENTF_KEYUP));
    for modifier in modifiers.iter().rev() {
        inputs.push(keyboard_input(*modifier, 0, KEYEVENTF_KEYUP));
    }
    submit(&inputs)
}

fn resolve_key(name: &str) -> Result<u16, String> {
    let named = match name {
        "ENTER" => Some(0x0D),
        "TAB" => Some(0x09),
        "ESC" | "ESCAPE" => Some(0x1B),
        "SPACE" => Some(0x20),
        "BACKSPACE" => Some(0x08),
        "DELETE" => Some(0x2E),
        "UP" => Some(0x26),
        "DOWN" => Some(0x28),
        "LEFT" => Some(0x25),
        "RIGHT" => Some(0x27),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" => Some(0x21),
        "PAGEDOWN" => Some(0x22),
        "F1" => Some(0x70),
        "F2" => Some(0x71),
        "F3" => Some(0x72),
        "F4" => Some(0x73),
        "F5" => Some(0x74),
        "F6" => Some(0x75),
        "F7" => Some(0x76),
        "F8" => Some(0x77),
        "F9" => Some(0x78),
        "F10" => Some(0x79),
        "F11" => Some(0x7A),
        "F12" => Some(0x7B),
        _ => None,
    };
    if let Some(key) = named {
        return Ok(key);
    }
    let mut chars = name.encode_utf16();
    if let (Some(character), None) = (chars.next(), chars.next()) {
        let mapped = unsafe { VkKeyScanW(character) };
        if mapped != -1 {
            return Ok(mapped as u16 & 0xff);
        }
    }
    Err(format!("Unsupported key: {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_named_keys() {
        assert_eq!(resolve_key("ENTER").unwrap(), 0x0D);
        assert_eq!(resolve_key("F12").unwrap(), 0x7B);
    }

    #[test]
    fn parses_stable_element_refs() {
        let (handle, runtime_id) = parse_element_ref("uia:1234:42.-7.99").unwrap();
        assert_eq!(handle as usize, 1234);
        assert_eq!(runtime_id, vec![42, -7, 99]);
        assert!(parse_element_ref("css:button").is_err());
    }

    #[test]
    fn frame_fingerprint_changes_with_pixels() {
        assert_eq!(frame_id(&[1, 2, 3]), frame_id(&[1, 2, 3]));
        assert_ne!(frame_id(&[1, 2, 3]), frame_id(&[1, 2, 4]));
    }

    #[test]
    fn encodes_capture_metadata_for_any_backend() {
        let capture =
            encode_capture(&[0, 0, 255, 255, 0, 255, 0, 255], 2, 1, 10, 20, "wgc", None).unwrap();
        assert_eq!(capture.width, 2);
        assert_eq!(capture.height, 1);
        assert_eq!(capture.image_width, 2);
        assert_eq!(capture.capture_backend, "wgc");
        assert!(capture.capture_fallback.is_none());
        assert!(!capture.data.is_empty());
    }

    #[test]
    fn executes_native_batch_in_order() {
        let request = serde_json::from_value::<Request>(serde_json::json!({
            "action": "batch",
            "actions": [
                { "action": "wait", "durationMs": 0 },
                { "action": "wait", "durationMs": 0 }
            ]
        }))
        .unwrap();
        assert!(matches!(
            handle(request).unwrap(),
            Response::Batch {
                ok: true,
                completed: 2
            }
        ));
    }

    #[test]
    fn rejects_nested_or_unbounded_batches() {
        let nested = serde_json::from_value::<Request>(serde_json::json!({
            "action": "batch",
            "actions": [{ "action": "batch", "actions": [{ "action": "wait" }] }]
        }))
        .unwrap();
        let nested_error = match handle(nested) {
            Err(error) => error,
            Ok(_) => panic!("nested batch should fail"),
        };
        assert!(nested_error.contains("not an atomic action"));

        let too_long = serde_json::from_value::<Request>(serde_json::json!({
            "action": "batch",
            "actions": [
                { "action": "wait", "durationMs": 20000 },
                { "action": "wait", "durationMs": 20000 }
            ]
        }))
        .unwrap();
        let duration_error = match handle(too_long) {
            Err(error) => error,
            Ok(_) => panic!("unbounded batch should fail"),
        };
        assert!(duration_error.contains("must not exceed"));
    }
}
