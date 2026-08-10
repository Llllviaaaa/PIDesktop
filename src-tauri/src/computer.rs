use std::io::{self, Read};
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;

use base64::Engine;
use serde::{Deserialize, Serialize};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
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
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    IsWindowVisible, SetCursorPos, SetForegroundWindow, ShowWindowAsync, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    action: String,
    x: Option<i32>,
    y: Option<i32>,
    button: Option<String>,
    count: Option<u32>,
    text: Option<String>,
    key: Option<String>,
    window_title: Option<String>,
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
    Windows { windows: Vec<WindowInfo> },
    Ok { ok: bool },
    Error { ok: bool, error: String },
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
        "screenshot" => capture_screen().map(Response::Capture),
        "list_windows" => Ok(Response::Windows {
            windows: list_windows()?,
        }),
        "focus_window" => {
            focus_window(request.window_title.as_deref().unwrap_or_default())?;
            Ok(Response::Ok { ok: true })
        }
        "click" => {
            click(
                request.x.ok_or("click requires x")?,
                request.y.ok_or("click requires y")?,
                request.button.as_deref().unwrap_or("left"),
                request.count.unwrap_or(1).clamp(1, 2),
            )?;
            Ok(Response::Ok { ok: true })
        }
        "type" => {
            type_text(request.text.as_deref().ok_or("type requires text")?)?;
            Ok(Response::Ok { ok: true })
        }
        "key" => {
            press_combo(request.key.as_deref().ok_or("key requires key")?)?;
            Ok(Response::Ok { ok: true })
        }
        _ => Err(format!("Unsupported computer action: {}", request.action)),
    }
}

fn capture_screen() -> Result<Capture, String> {
    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
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

    let scale = f64::min(1.0, f64::min(1600.0 / width as f64, 1000.0 / height as f64));
    let output_width = (width as f64 * scale).round().max(1.0) as u32;
    let output_height = (height as f64 * scale).round().max(1.0) as u32;
    let mut rgb = vec![0_u8; output_width as usize * output_height as usize * 3];
    for y in 0..output_height {
        let source_y = (y as u64 * height as u64 / output_height as u64) as usize;
        for x in 0..output_width {
            let source_x = (x as u64 * width as u64 / output_width as u64) as usize;
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
        width,
        height,
        left,
        top,
    })
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
    if fragment.trim().is_empty() {
        return Err("focus_window requires a window title".to_string());
    }
    let query = fragment.to_lowercase();
    let window = list_windows()?
        .into_iter()
        .find(|window| window.title.to_lowercase().contains(&query))
        .ok_or_else(|| format!("No visible window matches: {fragment}"))?;
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

fn mouse_input(flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
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
    if unsafe { SetCursorPos(x, y) } == 0 {
        return Err("Windows could not move the pointer".to_string());
    }
    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => return Err(format!("Unsupported mouse button: {button}")),
    };
    for _ in 0..count {
        submit(&[mouse_input(down), mouse_input(up)])?;
    }
    Ok(())
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
}
