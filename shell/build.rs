use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let mut parts: Vec<&str> = version.split('.').collect();
    while parts.len() < 4 {
        parts.push("0");
    }
    let ver_comma = parts.join(",");
    let ver_dot = parts.join(".");

    #[cfg(target_os = "windows")]
    {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

        // Use the original icon.rc as the icon source (relative path works).
        let rc_src = manifest_dir.join("icon.rc");
        // Write a separate version-info .rc file with the real version numbers.
        let ver_rc = out_dir.join("version.rc");
        let ver_obj = out_dir.join("version.o");

        let ver_content = format!(
            r##"#include "windows.h"

VS_VERSION_INFO VERSIONINFO
 FILEVERSION    {ver_comma}
 PRODUCTVERSION {ver_comma}
 FILEFLAGSMASK  0x3fL
 FILEFLAGS      0x0L
 FILEOS         VOS_NT_WINDOWS32
 FILETYPE       VFT_APP
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "FileDescription",  "Future Academy Link\0"
      VALUE "FileVersion",      "{ver_dot}\0"
      VALUE "InternalName",     "FutureAcademyTray\0"
      VALUE "OriginalFilename", "FutureAcademyTray.exe\0"
      VALUE "ProductName",      "Future Academy Link\0"
      VALUE "ProductVersion",   "{ver_dot}\0"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"##,
        );
        fs::write(&ver_rc, &ver_content).expect("write version.rc");

        // Compile icon.rc → icon.o (original approach, uses relative path)
        let icon_obj = out_dir.join("icon.o");
        let mut compiled_any = false;

        let result = Command::new("windres")
            .arg(&rc_src)
            .arg("-O")
            .arg("coff")
            .arg("-o")
            .arg(&icon_obj)
            .status();
        if result.map(|s| s.success()).unwrap_or(false) {
            compiled_any = true;
            println!("cargo:rustc-link-arg-bins={}", icon_obj.display());
        } else {
            // fallback: rc.exe + cvtres.exe
            let res = out_dir.join("icon.res");
            let _ = Command::new("rc.exe")
                .arg("/fo")
                .arg(&res)
                .arg(&rc_src)
                .status();
            let _ = Command::new("cvtres.exe")
                .arg("/machine:x64")
                .arg(&format!("/out:{}", icon_obj.display()))
                .arg(&res)
                .status();
            if icon_obj.exists() {
                compiled_any = true;
                println!("cargo:rustc-link-arg-bins={}", icon_obj.display());
            }
        }

        // Compile version.rc → version.o
        let result2 = Command::new("windres")
            .arg(&ver_rc)
            .arg("-O")
            .arg("coff")
            .arg("-o")
            .arg(&ver_obj)
            .status();
        if result2.map(|s| s.success()).unwrap_or(false) {
            compiled_any = true;
            println!("cargo:rustc-link-arg-bins={}", ver_obj.display());
        } else {
            let res2 = out_dir.join("version.res");
            let _ = Command::new("rc.exe")
                .arg("/fo")
                .arg(&res2)
                .arg(&ver_rc)
                .status();
            let _ = Command::new("cvtres.exe")
                .arg("/machine:x64")
                .arg(&format!("/out:{}", ver_obj.display()))
                .arg(&res2)
                .status();
            if ver_obj.exists() {
                compiled_any = true;
                println!("cargo:rustc-link-arg-bins={}", ver_obj.display());
            }
        }

        if !compiled_any {
            panic!("failed to compile .rc resources — ensure windres or rc.exe is available");
        }

        println!("cargo:rerun-if-changed=build.rs");
        println!("cargo:rerun-if-changed=icon.rc");
    }

    #[cfg(not(target_os = "windows"))]
    {
        println!("cargo:rerun-if-changed=build.rs");
    }
}