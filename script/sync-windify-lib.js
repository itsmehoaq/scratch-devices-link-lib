const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const librariesRoot = path.join(repoRoot, 'tools', 'Arduino', 'libraries');
const windifyRoot = path.join(librariesRoot, 'Windify');
const srcRoot = path.join(windifyRoot, 'src');

const writeFile = (relativePath, content) => {
    const target = path.join(windifyRoot, relativePath);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content, 'utf8');
};

const libraryProperties = `name=Windify
version=2.0.3
author=Windify
maintainer=Windify
sentence=Windify Arduino helpers for Future Academy boards.
paragraph=Bundled AT32 I2C helpers and ESP32-S3 PCM audio playback helpers used by generated Windify sketches.
category=Device Control
architectures=esp32
`;

const windifyHeader = `#ifndef WINDIFY_H
#define WINDIFY_H

#include <Arduino.h>
#include <Wire.h>
#include <stdint.h>
#include <stddef.h>

#ifndef WINDIFY_I2S_BCLK_PIN
#define WINDIFY_I2S_BCLK_PIN 5
#endif

#ifndef WINDIFY_I2S_LRCLK_PIN
#define WINDIFY_I2S_LRCLK_PIN 25
#endif

#ifndef WINDIFY_I2S_DOUT_PIN
#define WINDIFY_I2S_DOUT_PIN 26
#endif

#ifndef WINDIFY_I2S_ENABLE_PIN
#define WINDIFY_I2S_ENABLE_PIN -1
#endif

#define AT32_SDA_PIN 42
#define AT32_SCL_PIN 2
#define AT32_I2C_FREQ 100000UL

#define AT32_MUX1 0x70
#define AT32_MUX2 0x74

void at32MuxDisable(uint8_t mux);
void at32DisableAllMux();
void at32CloseMux();
bool at32TcaSelectBus(uint8_t mux, uint8_t channel);
bool at32TcaSelect(uint8_t mux, uint8_t channel);
void at32AfterSlaveWrite();
long at32ClampLong(long value, long low, long high);
void at32Begin();

bool at32SlaveWrite1(uint8_t addr, uint8_t b0);
bool at32SlaveWrite2(uint8_t addr, uint8_t b0, uint8_t b1);
bool at32SlaveWrite3(uint8_t addr, uint8_t b0, uint8_t b1, uint8_t b2);
bool at32SlaveWrite4(uint8_t addr, uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3);
bool at32SlaveWrite5(uint8_t addr, uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3, uint8_t b4);

int at32ReadU8(uint8_t mux, uint8_t channel, uint8_t addr);
int at32ReadU16LE(uint8_t mux, uint8_t channel, uint8_t addr);
int16_t at32ReadS16LE(uint8_t mux, uint8_t channel, uint8_t addr);
int at32AdcPercent(int raw);

bool windifyEsp32AudioConnect(uint32_t sampleRate = 44100);
void windifyEsp32AudioSetVolumePercent(int percent);
int windifyEsp32AudioGetVolumePercent();
bool windifyEsp32AudioPlayPcm16(const int16_t *samples, size_t sampleCount, uint32_t sampleRate);

#endif
`;

const windifySource = `#include "Windify.h"

#if defined(ARDUINO_ARCH_ESP32)
#include <ESP_I2S.h>
#include <pgmspace.h>
#endif

void at32MuxDisable(uint8_t mux) {
  Wire.beginTransmission(mux);
  Wire.write((uint8_t)0x00);
  Wire.endTransmission();
}

void at32DisableAllMux() {
  at32MuxDisable(AT32_MUX1);
  at32MuxDisable(AT32_MUX2);
}

void at32CloseMux() {
  at32DisableAllMux();
}

bool at32TcaSelectBus(uint8_t mux, uint8_t channel) {
  if (channel > 7) return false;
  Wire.beginTransmission(mux);
  Wire.write((uint8_t)(1U << channel));
  return Wire.endTransmission() == 0;
}

bool at32TcaSelect(uint8_t mux, uint8_t channel) {
  at32DisableAllMux();
  bool ok = at32TcaSelectBus(mux, channel);
  delayMicroseconds(300);
  return ok;
}

void at32AfterSlaveWrite() {
  delayMicroseconds(300);
  at32CloseMux();
}

long at32ClampLong(long value, long low, long high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

void at32Begin() {
#if defined(ARDUINO_ARCH_ESP32)
  Wire.setPins(AT32_SDA_PIN, AT32_SCL_PIN);
  Wire.begin();
  Wire.setBufferSize(256);
#else
  Wire.begin(AT32_SDA_PIN, AT32_SCL_PIN);
#endif
  Wire.setClock(AT32_I2C_FREQ);
  at32DisableAllMux();
}

bool at32SlaveWrite1(uint8_t addr, uint8_t b0) {
  for (uint8_t t = 0; t < 3u; t++) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)0x00);
    Wire.write(b0);
    if (Wire.endTransmission() == 0) return true;
    delayMicroseconds(120 + 100 * t);
  }
  return false;
}

bool at32SlaveWrite2(uint8_t addr, uint8_t b0, uint8_t b1) {
  for (uint8_t t = 0; t < 3u; t++) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)0x00);
    Wire.write(b0);
    Wire.write(b1);
    if (Wire.endTransmission() == 0) return true;
    delayMicroseconds(120 + 100 * t);
  }
  return false;
}

bool at32SlaveWrite3(uint8_t addr, uint8_t b0, uint8_t b1, uint8_t b2) {
  for (uint8_t t = 0; t < 3u; t++) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)0x00);
    Wire.write(b0);
    Wire.write(b1);
    Wire.write(b2);
    if (Wire.endTransmission() == 0) return true;
    delayMicroseconds(120 + 100 * t);
  }
  return false;
}

bool at32SlaveWrite4(uint8_t addr, uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3) {
  for (uint8_t t = 0; t < 3u; t++) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)0x00);
    Wire.write(b0);
    Wire.write(b1);
    Wire.write(b2);
    Wire.write(b3);
    if (Wire.endTransmission() == 0) return true;
    delayMicroseconds(120 + 100 * t);
  }
  return false;
}

bool at32SlaveWrite5(uint8_t addr, uint8_t b0, uint8_t b1, uint8_t b2, uint8_t b3, uint8_t b4) {
  for (uint8_t t = 0; t < 3u; t++) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)0x00);
    Wire.write(b0);
    Wire.write(b1);
    Wire.write(b2);
    Wire.write(b3);
    Wire.write(b4);
    if (Wire.endTransmission() == 0) return true;
    delayMicroseconds(120 + 100 * t);
  }
  return false;
}

int at32ReadU8(uint8_t mux, uint8_t channel, uint8_t addr) {
  if (!at32TcaSelect(mux, channel)) return -1;
  int value = -1;
  uint8_t n = Wire.requestFrom((uint8_t)addr, (uint8_t)2);
  if (n >= 2 && Wire.available() >= 2) {
    (void)Wire.read();
    value = (int)Wire.read();
  }
  while (Wire.available()) Wire.read();
  at32CloseMux();
  return value;
}

int at32ReadU16LE(uint8_t mux, uint8_t channel, uint8_t addr) {
  if (!at32TcaSelect(mux, channel)) return -1;
  int value = -1;
  uint8_t n = Wire.requestFrom((uint8_t)addr, (uint8_t)3);
  if (n >= 3 && Wire.available() >= 3) {
    (void)Wire.read();
    uint8_t lo = Wire.read();
    uint8_t hi = Wire.read();
    value = (int)((uint16_t)lo | ((uint16_t)hi << 8));
  }
  while (Wire.available()) Wire.read();
  at32CloseMux();
  return value;
}

int16_t at32ReadS16LE(uint8_t mux, uint8_t channel, uint8_t addr) {
  int raw = at32ReadU16LE(mux, channel, addr);
  if (raw < 0) return (int16_t)0x8000;
  return (int16_t)((uint16_t)raw);
}

int at32AdcPercent(int raw) {
  if (raw < 0) return 0;
  if (raw > 4095) raw = 4095;
  return (int)((long)raw * 100L / 4095L);
}

#if defined(ARDUINO_ARCH_ESP32)
static I2SClass windifyI2S;
static bool windifyAudioReady = false;
static uint32_t windifyAudioRate = 0;
static int windifyAudioVolumePercent = 100;

static int16_t windifyScaleSample(int16_t sample) {
  int32_t scaled = ((int32_t)sample * windifyAudioVolumePercent) / 100;
  if (scaled > 32767) return 32767;
  if (scaled < -32768) return -32768;
  return (int16_t)scaled;
}
#endif

bool windifyEsp32AudioConnect(uint32_t sampleRate) {
#if defined(ARDUINO_ARCH_ESP32)
  if (windifyAudioReady && windifyAudioRate == sampleRate) {
    return true;
  }
  if (windifyAudioReady) {
    windifyI2S.end();
    windifyAudioReady = false;
  }
  if (WINDIFY_I2S_ENABLE_PIN >= 0) {
    pinMode(WINDIFY_I2S_ENABLE_PIN, OUTPUT);
    digitalWrite(WINDIFY_I2S_ENABLE_PIN, HIGH);
  }
  windifyI2S.setPins(WINDIFY_I2S_BCLK_PIN, WINDIFY_I2S_LRCLK_PIN, WINDIFY_I2S_DOUT_PIN);
  windifyAudioReady = windifyI2S.begin(
    I2S_MODE_STD,
    sampleRate,
    I2S_DATA_BIT_WIDTH_16BIT,
    I2S_SLOT_MODE_STEREO,
    I2S_STD_SLOT_BOTH
  );
  if (windifyAudioReady) {
    windifyAudioRate = sampleRate;
  }
  return windifyAudioReady;
#else
  (void)sampleRate;
  return false;
#endif
}

void windifyEsp32AudioSetVolumePercent(int percent) {
#if defined(ARDUINO_ARCH_ESP32)
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  windifyAudioVolumePercent = percent;
#else
  (void)percent;
#endif
}

int windifyEsp32AudioGetVolumePercent() {
#if defined(ARDUINO_ARCH_ESP32)
  return windifyAudioVolumePercent;
#else
  return 0;
#endif
}

bool windifyEsp32AudioPlayPcm16(const int16_t *samples, size_t sampleCount, uint32_t sampleRate) {
#if defined(ARDUINO_ARCH_ESP32)
  if (!samples || sampleCount == 0) return false;
  if (!windifyEsp32AudioConnect(sampleRate)) return false;

  const size_t framesPerChunk = 128;
  int16_t stereo[framesPerChunk * 2];
  size_t offset = 0;
  while (offset < sampleCount) {
    size_t frames = sampleCount - offset;
    if (frames > framesPerChunk) frames = framesPerChunk;
    for (size_t i = 0; i < frames; i++) {
      int16_t sample = (int16_t)pgm_read_word(&samples[offset + i]);
      int16_t scaled = windifyScaleSample(sample);
      stereo[i * 2] = scaled;
      stereo[i * 2 + 1] = scaled;
    }
    size_t bytes = frames * 2 * sizeof(int16_t);
    if (windifyI2S.write((const uint8_t *)stereo, bytes) != bytes) {
      return false;
    }
    offset += frames;
  }
  return true;
#else
  (void)samples;
  (void)sampleCount;
  (void)sampleRate;
  return false;
#endif
}
`;

fs.mkdirSync(srcRoot, {recursive: true});
writeFile('library.properties', libraryProperties);
writeFile(path.join('src', 'Windify.h'), windifyHeader);
writeFile(path.join('src', 'Windify.cpp'), windifySource);

console.log(`[sync:windify-lib] wrote ${windifyRoot}`);
