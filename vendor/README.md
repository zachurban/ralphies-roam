# Vendored libraries

Kept in the repository (not loaded from a CDN) so Find the Herd's QR codes work offline and no third party sees when a herd forms.

| File | Library | Version | License | Used for |
|---|---|---|---|---|
| `qrcode.min.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | 1.4.4 | MIT | Drawing invite, rolling-code and clue-piece QR codes |
| `jsqr.min.js` | [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | Reading QR codes from the camera (loaded only when the scanner opens) |

Both are the published npm files minified with terser, with the license notice kept at the top. To update: `npm install <package>@<version>`, minify the same way, replace the file, and run `node --test tests/herd-core.test.cjs` (it draws a code with one and reads it back with the other).

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
