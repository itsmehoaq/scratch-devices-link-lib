# Tools compression

`npm run fetch` downloads the full WinBlock Arduino tool bundle. The full
bundle is useful for broad board support, but this project only needs Arduino
Uno and ESP32-S3. The local `tools` folder can therefore be pruned before it is
archived or distributed.

## Commands

```bash
npm run tools:prune:dry-run
npm run tools:prune
npm run tools:archive
```

Use `npm run fetch:small` to regenerate tools from scratch, prune them, and
create the archive in one command.

The archive is written to `tmp/tools-pruned-<platform>-<arch>.7z`. The `tmp`
directory is ignored by Git.

## Kept board support

The pruning script keeps the paths needed for:

- Arduino Uno compile and upload through `arduino:avr:uno`.
- ESP32-S3 compile through `esp32:esp32:esp32s3`.
- ESP32 binary flashing through bundled `esptool_py`.
- Shared sketch libraries under `tools/Arduino/libraries`.
- The embedded Python tools folder.

## Removed content

The script removes unrelated board packages and toolchains, including RP2040,
ESP8266, Maixduino, SparkFun, Arduino Renesas/ARM tooling, RISC-V ESP32 tools,
debug-only ESP32 tools, and non-S3 ESP32 precompiled SDK libraries.

If another board is added later, update `script/prune-tools.js` before running
`npm run tools:prune`; otherwise the required compiler or SDK files may be
removed.
