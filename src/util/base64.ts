/**
 * ASCII-güvenli base64 encode/decode.
 *
 * react-native-ble-plx tüm karakteristik değerlerini Base64 string olarak
 * alır/verir. Hermes'te `btoa`/`atob` her zaman garanti değil, bu yüzden
 * ELM327'nin yalnızca ASCII gönderip aldığı gerçeğine dayanan minimal,
 * bağımlılıksız bir implementasyon burada. Saf fonksiyonlar — cihazsız test
 * edilebilir.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeAsciiToBase64(input: string): string {
  let output = '';
  for (let i = 0; i < input.length; i += 3) {
    const b0 = input.charCodeAt(i) & 0xff;
    const hasB1 = i + 1 < input.length;
    const hasB2 = i + 2 < input.length;
    const b1 = hasB1 ? input.charCodeAt(i + 1) & 0xff : 0;
    const b2 = hasB2 ? input.charCodeAt(i + 2) & 0xff : 0;

    output += CHARS[b0 >> 2];
    output += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    output += hasB1 ? CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    output += hasB2 ? CHARS[b2 & 0x3f] : '=';
  }
  return output;
}

export function decodeBase64ToAscii(input: string): string {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  let output = '';
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = CHARS.indexOf(clean[i]);
    const c1 = CHARS.indexOf(clean[i + 1] ?? '=');
    const c2 = CHARS.indexOf(clean[i + 2] ?? '=');
    const c3 = CHARS.indexOf(clean[i + 3] ?? '=');

    const b0 = (c0 << 2) | (c1 >> 4);
    output += String.fromCharCode(b0 & 0xff);

    if (c2 >= 0) {
      const b1 = ((c1 & 0x0f) << 4) | (c2 >> 2);
      output += String.fromCharCode(b1 & 0xff);
    }
    if (c3 >= 0) {
      const b2 = ((c2 & 0x03) << 6) | c3;
      output += String.fromCharCode(b2 & 0xff);
    }
  }
  return output;
}
