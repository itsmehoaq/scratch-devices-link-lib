use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let obj = out_dir.join("icon.o");
    let rc_file = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("icon.rc");
    let ico_file = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .join("assets")
        .join("FutureAcademy.ico");

    // windres produces a GNU-coff .o that the linker accepts directly.
    let result = Command::new("windres")
        .arg(&rc_file)
        .arg("-O").arg("coff")
        .arg("-o").arg(&obj)
        .status();

    let ok = result.map(|s| s.success()).unwrap_or(false);
    if !ok {
        // fallback: rc.exe (MSVC) produces .res which we can convert with cvtres
        let res = out_dir.join("icon.res");
        let _ = Command::new("rc.exe")
            .arg("/fo").arg(&res)
            .arg(&rc_file)
            .status();
        // cvtres converts .res → .o for the GNU linker
        let _ = Command::new("cvtres.exe")
            .arg("/machine:").arg("x64")
            .arg("/out:").arg(&obj)
            .arg(&res)
            .status();
    }

    println!("cargo:rustc-link-arg-bins={}", obj.display());
    println!("cargo:rerun-if-changed=icon.rc");
    println!("cargo:rerun-if-changed={}", ico_file.display());
}
