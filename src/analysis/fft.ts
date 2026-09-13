/**
 * Gerçek değerli sinyaller için radix-2 FFT ve pencereleme.
 *
 * Neden dışarıdan paket almadık: ihtiyacımız olan tek şey sabit uzunlukta,
 * gerçek girdili bir dönüşüm. Bu kadarı altmış satır; bir bağımlılık eklemek
 * hem native build yüzeyini hem denetlenmesi gereken kod miktarını gereksiz
 * yere büyütürdü. Buradaki her fonksiyon saf — sentetik sinyallerle cihazsız
 * test ediliyor (bkz. tests/fft.test.ts).
 */

/** N'in 2'nin kuvveti olup olmadığı. */
export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Hann penceresi.
 *
 * Pencereleme şart: sinyali çıplak kesmek spektruma keskin bir kenarın
 * saçağını ekler (spectral leakage) ve zayıf bir yarım-order tepesini
 * güçlü ateşleme tepesinin eteğinde görünmez yapardı — tam da aradığımız
 * şeyi kaybederdik.
 */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

/**
 * Yerinde (in-place) radix-2 Cooley-Tukey FFT.
 *
 * `re` ve `im` aynı uzunlukta olmalı ve uzunluk 2'nin kuvveti olmalı.
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error('re and im must have the same length');
  if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`);

  // Bit ters çevirme sıralaması.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;

        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Gerçek girdinin genlik spektrumu (yalnızca ilk N/2 bin).
 *
 * Ölçekleme: tek frekanslı bir sinüsün genliği, penceresiz durumda kendi
 * tepe genliğini verecek şekilde normalize ediliyor (2/N). Pencere
 * uygulandığında pencere kazancı ayrıca telafi ediliyor ki Hann'ın
 * getirdiği ~0.5'lik zayıflama genlikleri yanıltmasın.
 */
export function magnitudeSpectrum(samples: ArrayLike<number>, window?: Float64Array): Float64Array {
  const n = samples.length;
  if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`);

  const re = new Float64Array(n);
  const im = new Float64Array(n);

  let windowGain = 1;
  if (window) {
    if (window.length !== n) throw new Error('window length must match sample count');
    let sum = 0;
    for (let i = 0; i < n; i++) {
      re[i] = samples[i] * window[i];
      sum += window[i];
    }
    windowGain = sum / n;
  } else {
    for (let i = 0; i < n; i++) re[i] = samples[i];
  }

  fftInPlace(re, im);

  const half = n >> 1;
  const out = new Float64Array(half);
  const scale = 2 / (n * windowGain);
  for (let i = 0; i < half; i++) {
    out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * scale;
  }
  return out;
}

/**
 * Hann penceresi için ENERJİ düzeltmesi.
 *
 * `magnitudeSpectrum` genliği pencerenin ortalama kazancına (0.5) göre
 * normalize eder; bu, tek bir tonun TEPE genliğini doğru verir. Ama
 * pencere tonu birkaç bine yayar ve bu binlerin GÜÇLERİ toplandığında
 * sonuç gerçek enerjinin 1.5 katı çıkar — çünkü pencerenin güç kazancı
 * (0.375) ile genlik kazancının karesi (0.25) aynı şey değildir:
 *
 *     0.375 / 0.5² = 1.5   →   10·log10(1.5) = 1.76 dB
 *
 * Spektrumdan SEVİYE hesaplayan her yer (bkz. analysis/spl.ts) bu
 * düzeltmeyi uygulamak zorunda; uygulamazsa ölçüm sistematik olarak
 * 1.76 dB yüksek okur. Bunu bir birim testi yakaladı.
 */
export const HANN_POWER_CORRECTION = 1.5;

/** Bin indeksinin karşılık geldiği frekans (Hz). */
export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

/** Frekansın düştüğü (kesirli) bin indeksi. */
export function hzToBin(hz: number, sampleRate: number, fftSize: number): number {
  return (hz * fftSize) / sampleRate;
}

/**
 * Bir frekansın çevresindeki tepe genliği.
 *
 * Tam bin üzerine düşmeyen bir ton iki bine yayılır; ayrıca devir tahmini
 * birkaç Hz şaşabilir. Bu yüzden hedefin ±`tolerance` bin komşuluğundaki
 * EN BÜYÜK değeri alıyoruz — tek bin okumak, gerçek tepeyi ıskalayıp
 * "sinyal yok" demeye yol açardı.
 */
export function peakNear(
  spectrum: ArrayLike<number>,
  hz: number,
  sampleRate: number,
  fftSize: number,
  tolerance = 2,
): number {
  const center = hzToBin(hz, sampleRate, fftSize);
  const from = Math.max(1, Math.floor(center - tolerance));
  const to = Math.min(spectrum.length - 1, Math.ceil(center + tolerance));
  if (from > to) return 0;

  let peak = 0;
  for (let i = from; i <= to; i++) {
    if (spectrum[i] > peak) peak = spectrum[i];
  }
  return peak;
}

/** Belirli bir frekans aralığındaki en güçlü bileşenin frekansı (Hz). */
export function dominantHzInBand(
  spectrum: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  fromHz: number,
  toHz: number,
): { hz: number; magnitude: number } | null {
  const from = Math.max(1, Math.ceil(hzToBin(fromHz, sampleRate, fftSize)));
  const to = Math.min(spectrum.length - 1, Math.floor(hzToBin(toHz, sampleRate, fftSize)));
  if (from > to) return null;

  let bestBin = -1;
  let best = 0;
  for (let i = from; i <= to; i++) {
    if (spectrum[i] > best) {
      best = spectrum[i];
      bestBin = i;
    }
  }
  if (bestBin < 0) return null;

  /**
   * Parabolik enterpolasyon: tepe iki bin arasına düştüğünde gerçek
   * frekansı bin çözünürlüğünden daha iyi kestiriyor. Devir tahmininde
   * fark ediyor — 1.95 Hz'lik bir bin, 850 rpm'de ~59 rpm demek.
   */
  const yPrev = spectrum[bestBin - 1] ?? 0;
  const y0 = spectrum[bestBin];
  const yNext = spectrum[bestBin + 1] ?? 0;
  const denom = yPrev - 2 * y0 + yNext;
  const delta = denom !== 0 ? (0.5 * (yPrev - yNext)) / denom : 0;
  const refined = bestBin + (Math.abs(delta) <= 1 ? delta : 0);

  return { hz: binToHz(refined, sampleRate, fftSize), magnitude: best };
}

/** Sinyalin RMS'i. */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

/** RMS'ten dBFS. Tam ölçek 1.0 kabul edilir. */
export function rmsToDbfs(value: number): number {
  if (value <= 0) return -160;
  return Math.max(-160, 20 * Math.log10(value));
}
