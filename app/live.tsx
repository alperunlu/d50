import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore, ALL_PIDS } from '../src/state/store';
import { orderedCards } from '../src/data/cardOrder';
import { getPidDefinition } from '../src/obd/pids';
import { getChannel, SELECTABLE_SENSOR_CHANNELS } from '../src/data/channels';
import { deriveLive, type DerivedReading } from '../src/analysis/live';
import { describeSpl, MIN_SPL_CALIBRATION_DB, MAX_SPL_CALIBRATION_DB } from '../src/analysis/spl';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { DragGrid } from '../src/ui/DragGrid';
import {
  Frame,
  Label,
  Measure,
  Sparkline,
  StatusDot,
  PrimaryAction,
  GhostAction,
  Rule,
  SectionRule,
  Note,
} from '../src/ui/primitives';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Canlı ekran.
 *
 * Tasarım kuralı: "Bir sayı ekranın sahibidir. İkincil kanallar görünür bir
 * ızgarada eşit hücrelerdir, her birinin altında iz. Hiçbiri dolu kart değil."
 *
 * Hangi kanalın hero olacağı kullanıcının seçtiği ilk kanaldır — sürüşte
 * bakılan şey kişiye göre değişir (biri devir, biri su sıcaklığı izler).
 */
export default function LiveScreen() {
  const connectionState = useAppStore((s) => s.connectionState);
  const selectedPids = useAppStore((s) => s.selectedPids);
  const liveSeries = useAppStore((s) => s.liveSeries);
  const isRecording = useAppStore((s) => s.isRecording);
  const recordingGaps = useAppStore((s) => s.recordingGaps);
  const sampleRate = useAppStore((s) => s.sampleRate);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const togglePid = useAppStore((s) => s.togglePid);
  const isPidSupported = useAppStore((s) => s.isPidSupported);
  const selectedSensorChannels = useAppStore((s) => s.selectedSensorChannels);
  const toggleSensorChannel = useAppStore((s) => s.toggleSensorChannel);
  const sensorStatus = useAppStore((s) => s.sensorStatus);

  const soundMeterOn = useAppStore((s) => s.soundMeterOn);
  const soundNow = useAppStore((s) => s.soundNow);
  const soundMin = useAppStore((s) => s.soundMin);
  const soundMax = useAppStore((s) => s.soundMax);
  const soundAvg = useAppStore((s) => s.soundAvg);
  const soundError = useAppStore((s) => s.soundError);
  const splCalibrationDb = useAppStore((s) => s.splCalibrationDb);
  const startSoundMeter = useAppStore((s) => s.startSoundMeter);
  const stopSoundMeter = useAppStore((s) => s.stopSoundMeter);
  const resetSoundStats = useAppStore((s) => s.resetSoundStats);
  const setSplCalibration = useAppStore((s) => s.setSplCalibration);

  const [picking, setPicking] = useState(false);
  // Sürükleme sırasında ScrollView kilitleniyor; yoksa kart yerine
  // ekran kayıyor.
  const [dragging, setDragging] = useState(false);

  const cardOrder = useAppStore((s) => s.cardOrder);
  const moveCard = useAppStore((s) => s.moveCard);
  const cards = orderedCards({ selectedPids, selectedSensorChannels, cardOrder });

  const notConnected = connectionState !== 'connected';
  // İlk kart "hero", gerisi ızgara. Sıra kullanıcının kendi düzeni.
  const heroKey = cards[0];
  const cellKeys = cards.slice(1);

  if (picking) {
    return (
      <ChannelPicker
        selected={selectedPids}
        isSupported={isPidSupported}
        onToggle={togglePid}
        selectedSensorChannels={selectedSensorChannels}
        onToggleSensorChannel={toggleSensorChannel}
        sensorStatus={sensorStatus}
        onDone={() => setPicking(false)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />

      <View style={styles.body}>
        <View style={styles.topRow}>
          <View style={styles.rateRow}>
            <Text
              style={[
                type.cellValue,
                { fontSize: 22, lineHeight: 24 },
                !isRecording && { color: color.muted },
              ]}
            >
              {isRecording ? sampleRate.toFixed(1) : '·'}
            </Text>
            <Label small>samples/s</Label>
          </View>

          <Pressable
            style={[styles.recordChip, isRecording && { borderColor: color.alert }]}
            onPress={() => (isRecording ? stopRecording() : startRecording())}
            disabled={notConnected}
          >
            <StatusDot
              text={isRecording ? 'Recording' : 'Record'}
              tint={isRecording ? color.alert : color.chrome}
            />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!dragging}
        >
          {notConnected && (
            <Text style={[type.meta, styles.hint]}>
              Not linked. Open Link and connect to the adapter.
            </Text>
          )}

          {selectedPids.length === 0 && (
            <Text style={[type.meta, styles.hint]}>No channels selected.</Text>
          )}

          {/*
            Arka planda geçen süre kaydedilmiyor. Sessizce eksik bir gezi
            teslim etmektense burada söylemek gerekiyor: kullanıcı ya
            telefonu açık bırakır ya da eksiği bilerek kabul eder.
          */}
          {recordingGaps.length > 0 && (
            <Text style={[type.meta, styles.hint, { color: color.caution }]}>
              {`${recordingGaps.length} gap${recordingGaps.length === 1 ? '' : 's'} in this recording — ` +
                `${recordingGaps.reduce((total, g) => total + g.seconds, 0)} s were not recorded while the app was in the background. ` +
                'Keep the app open and the screen on.'}
            </Text>
          )}

          {/*
            Kartlar yerlerinde sürüklenebiliyor: bir kartı basılı tutup
            başka bir kartın üstüne bırakınca sıra değişiyor. İlk kart
            ekranın sahibi olan büyük kart.
          */}
          <DragGrid
            cards={cards}
            onReorder={moveCard}
            onDragStateChange={setDragging}
            renderHero={(key) => (
              <HeroChannel channelKey={key} series={liveSeries[key] ?? []} />
            )}
            renderCell={(key) => (
              <CellChannel channelKey={key} series={liveSeries[key] ?? []} />
            )}
          />

          <SoundMeter
            on={soundMeterOn}
            now={soundNow}
            min={soundMin}
            max={soundMax}
            avg={soundAvg}
            error={soundError}
            calibration={splCalibrationDb}
            onStart={() => void startSoundMeter()}
            onStop={stopSoundMeter}
            onReset={resetSoundStats}
            onCalibrate={(delta) => void setSplCalibration(splCalibrationDb + delta)}
          />

          <DerivedSection series={liveSeries} isPidSupported={isPidSupported} />
        </ScrollView>

        <View style={styles.footer}>
          <Rule strong />
          <View style={styles.footerRow}>
            <Label small>
              {cards.length > 1 ? 'Hold a card to move it' : `${cards.length} card`}
            </Label>
            <Pressable onPress={() => setPicking(true)}>
              <Text style={styles.chooseLink}>Choose channels</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Ekranın sahibi olan kanal.
 *
 * `React.memo`: sürüklerken hedef kart değiştikçe DragGrid yeniden
 * çiziliyor. Kart içerikleri (grafik dahil) her seferinde yeniden
 * hesaplanırsa sürükleme takılıyor; verisi değişmediyse çizilmiyorlar.
 */
const HeroChannel = React.memo(function HeroChannel({
  channelKey,
  series,
}: {
  channelKey: string;
  series: readonly { ts: number; value: number }[];
}) {
  const channel = getChannel(channelKey);
  const pid = getPidDefinition(channelKey);
  const latest = series.length > 0 ? series[series.length - 1].value : null;

  return (
    <Frame style={styles.heroFrame} cornerTint="rgba(241,235,221,0.5)">
      <View style={styles.cellHead}>
        <Label>{channel?.name ?? channelKey}</Label>
        {pid ? <Text style={type.metaSmall}>{`PID 01${pid.pid}`}</Text> : null}
      </View>
      <Measure hero value={latest === null ? null : formatValue(latest)} unit={channel?.unit ?? ''} />
      <Sparkline points={series} height={40} tint={color.linked} />
    </Frame>
  );
});

/** Izgaradaki ikincil kanal hücresi. Gerekçe HeroChannel'daki gibi. */
const CellChannel = React.memo(function CellChannel({
  channelKey,
  series,
}: {
  channelKey: string;
  series: readonly { ts: number; value: number }[];
}) {
  const channel = getChannel(channelKey);
  const latest = series.length > 0 ? series[series.length - 1].value : null;

  return (
    <Frame style={styles.cellInner}>
      <Label small>{channel?.short ?? channelKey}</Label>
      <Measure value={latest === null ? null : formatValue(latest)} unit={channel?.unit ?? ''} />
      <Sparkline points={series} height={20} />
    </Frame>
  );
});

/**
 * Gürültü ölçer — dB(A).
 *
 * OBD'den bağımsız: adaptör bağlı olmasa da çalışıyor, çünkü "kabinde ne
 * kadar gürültü var" sorusunun aracın ECU'suyla ilgisi yok. Ölçüm ayrı
 * bir uygulama gerektirmesin diye buraya kondu.
 *
 * Anlık değerin yanında MIN/ORT/MAKS de gösteriliyor: gürültü sürekli
 * dalgalanır, tek bir anlık sayı ("73") aslında hiçbir şey söylemez.
 * Bir desibelmetreyi kullanılabilir kılan, bir süre boyunca tutulan
 * bu üç değerdir.
 */
function SoundMeter({
  on,
  now,
  min,
  max,
  avg,
  error,
  calibration,
  onStart,
  onStop,
  onReset,
  onCalibrate,
}: {
  on: boolean;
  now: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  error: string | null;
  calibration: number;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onCalibrate: (delta: number) => void;
}) {
  return (
    <View style={{ marginTop: space(2) }}>
      <SectionRule
        label="Noise"
        meta={on ? 'Measuring' : 'Off'}
        metaColor={on ? color.linked : undefined}
      />

      <Frame style={styles.soundFrame} cornerTint="rgba(241,235,221,0.5)">
        <Measure hero value={now === null ? null : now.toFixed(1)} unit="dB(A)" />
        <Text style={[type.meta, { marginTop: space(1) }]}>
          {now === null ? 'Not measuring' : describeSpl(now)}
        </Text>

        <View style={styles.soundStats}>
          <SoundStat label="Min" value={min} />
          <SoundStat label="Avg" value={avg} />
          <SoundStat label="Max" value={max} />
        </View>
      </Frame>

      <View style={styles.soundActions}>
        {on ? (
          <GhostAction label="Stop" onPress={onStop} style={{ flex: 1 }} />
        ) : (
          <PrimaryAction label="Measure" onPress={onStart} style={{ flex: 1 }} />
        )}
        <GhostAction label="Reset" onPress={onReset} style={{ flex: 1 }} />
      </View>

      {/*
        Kalibrasyon: telefon mikrofonu kalibre bir ölçüm cihazı değil, o yüzden
        mutlak doğruluk ancak bilinen bir referansla eşitlenerek sağlanır.
        Ticari desibelmetre uygulamalarının yaptığı da budur.
      */}
      <View style={styles.calibrationRow}>
        <View style={{ flex: 1 }}>
          <Label small>Calibration</Label>
          <Text style={[type.metaSmall, { marginTop: space(0.75), lineHeight: 14 }]}>
            {`0 dBFS = ${calibration} dB SPL. Put a meter you trust next to the phone and nudge until they agree.`}
          </Text>
        </View>
        <Pressable
          style={styles.calButton}
          onPress={() => onCalibrate(-1)}
          disabled={calibration <= MIN_SPL_CALIBRATION_DB}
        >
          <Text style={[type.status, { color: color.ink, fontSize: 15 }]}>−</Text>
        </Pressable>
        <Pressable
          style={styles.calButton}
          onPress={() => onCalibrate(1)}
          disabled={calibration >= MAX_SPL_CALIBRATION_DB}
        >
          <Text style={[type.status, { color: color.ink, fontSize: 15 }]}>+</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={[type.meta, { color: color.caution, marginTop: space(2) }]}>{error}</Text>
      ) : null}
    </View>
  );
}

function SoundStat({ label, value }: { label: string; value: number | null }) {
  return (
    <View style={{ flex: 1 }}>
      <Label small>{label}</Label>
      <Text style={[type.cellValue, { fontSize: 18, lineHeight: 20, marginTop: space(0.5) }]}>
        {value === null ? '·' : value.toFixed(1)}
      </Text>
    </View>
  );
}

/**
 * Türetilmiş ölçümler — tek bir PID'in söyleyemeyeceği şeyler.
 *
 * Hesaplanamayanlar gizlenmiyor: hangi kanalı açması gerektiği yazıyor.
 * "—" gösterip kullanıcıyı tahmine bırakmak, ölçüm aletinde en kötü davranış.
 */
function DerivedSection({
  series,
  isPidSupported,
}: {
  series: Record<string, readonly { ts: number; value: number }[]>;
  isPidSupported: (pid: string) => boolean;
}) {
  const readings = deriveLive(series, { isPidSupported });
  const available = readings.filter((r) => r.value !== null);
  // Eylem alınabilir: kanal kapalı olduğu için hesaplanamıyor.
  const actionable = readings.filter((r) => r.value === null && r.missing.length > 0);
  // Eylem alınamaz: araç gerekli sensöre sahip değil. Ayrı yazılıyor, çünkü
  // kullanıcının burada deneyecek bir şeyi yok — boşuna uğraşmasın.
  const impossible = readings.filter(
    (r) => r.value === null && r.missing.length === 0 && r.unsupported.length > 0,
  );

  return (
    <View style={{ marginTop: space(2) }}>
      <SectionRule label="Derived" meta={`${available.length} of ${readings.length}`} />

      {available.map((r) => (
        <DerivedRow key={r.key} reading={r} />
      ))}

      {actionable.length > 0 && (
        <Note>
          {actionable
            .map((r) => `${r.name} needs ${[...new Set(r.missing)].join(' + ')}`)
            .join('. ')}
          {'. Enable those channels to compute them.'}
        </Note>
      )}

      {impossible.length > 0 && (
        <Note>
          {'Not available on this car: '}
          {impossible
            .map((r) => `${r.name} (no ${[...new Set(r.unsupported)].join(' / ')})`)
            .join(', ')}
          {'. The ECU does not report the required sensor.'}
        </Note>
      )}
    </View>
  );
}

function DerivedRow({ reading }: { reading: DerivedReading }) {
  return (
    <View style={styles.derivedRow}>
      <View style={{ flex: 1 }}>
        <Text style={[type.prose, { color: color.ink }]}>{reading.name}</Text>
        {reading.estimateNote ? (
          <Text style={[type.metaSmall, { marginTop: space(0.75) }]}>{reading.estimateNote}</Text>
        ) : null}
      </View>
      <View style={styles.derivedValue}>
        <Text style={[type.cellValue, { fontSize: 22, lineHeight: 24 }]}>
          {formatValue(reading.value as number)}
        </Text>
        <Text style={type.unitSmall}>{reading.unit}</Text>
      </View>
    </View>
  );
}

/** Kanal seçimi — Live'ı kalabalıklaştırmamak için ayrı bir yüzey. */
function ChannelPicker({
  selected,
  isSupported,
  onToggle,
  selectedSensorChannels,
  onToggleSensorChannel,
  sensorStatus,
  onDone,
}: {
  selected: readonly string[];
  isSupported: (pid: string) => boolean;
  onToggle: (pid: string) => void;
  selectedSensorChannels: readonly string[];
  onToggleSensorChannel: (key: string) => Promise<void>;
  sensorStatus: string | null;
  onDone: () => void;
}) {
  /**
   * Aracın desteklemediği PID'ler listeden ÇIKARILIYOR, soluk gösterilmiyor.
   *
   * Gerekçe: dokunulamayan bir satır menüde yer kaplamaktan başka bir şey
   * yapmıyor ve "acaba bir yolu var mı" diye düşündürüyor. R50'de katalogun
   * yarısı bu durumda. Destek bilgisi bilinmiyorken (bağlanılmadan önce)
   * `isSupported` hepsine `true` döner, yani liste tam görünür.
   */
  const visible = ALL_PIDS.filter((pid) => isSupported(pid.pid));
  const hiddenCount = ALL_PIDS.length - visible.length;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />
      <View style={styles.body}>
        <View style={{ marginBottom: space(3) }}>
          <Label>Channels</Label>
          <Text style={[type.meta, { marginTop: space(1.5), lineHeight: 16 }]}>
            One PID at a time on the K-line bus — fewer channels, faster sampling. The first
            selected channel owns the Live screen.
            {hiddenCount > 0
              ? ` ${hiddenCount} channels hidden — this ECU does not report them.`
              : ''}
          </Text>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {visible.map((pid) => {
            const on = selected.includes(pid.pid);
            const order = selected.indexOf(pid.pid);
            return (
              <Pressable
                key={pid.pid}
                style={styles.pickRow}
                onPress={() => onToggle(pid.pid)}
              >
                <View style={styles.pickMark}>
                  {on ? (
                    <Text style={[type.status, { color: color.ink, fontSize: 12 }]}>
                      {order === 0 ? '★' : String(order + 1)}
                    </Text>
                  ) : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[type.prose, { color: on ? color.ink : color.chrome }]}>
                    {pid.name}
                  </Text>
                  <Text style={type.metaSmall}>{`01${pid.pid} · ${pid.unit}`}</Text>
                </View>
              </Pressable>
            );
          })}

          {/*
            Telefon sensörleri OBD kanallarıyla AYNI listede ve AYNI
            granülerlikte: her satır ekrana eklenecek tek bir kart. Hangi
            donanımın açılacağı seçimden türetiliyor, kullanıcıya
            sorulmuyor — desibelmetre isteyen birine tekleme order'ı
            kartı açmak yanlıştı.
          */}
          <View style={{ marginTop: space(5) }}>
            <SectionRule
              label="Phone sensors"
              meta={`${selectedSensorChannels.length} selected`}
            />
            {SELECTABLE_SENSOR_CHANNELS.map((c) => {
              const on = selectedSensorChannels.includes(c.key);
              const order = selectedSensorChannels.indexOf(c.key);
              return (
                <Pressable
                  key={c.key}
                  style={styles.pickRow}
                  onPress={() => void onToggleSensorChannel(c.key)}
                >
                  <View style={styles.pickMark}>
                    {on ? (
                      <Text style={[type.status, { color: color.ink, fontSize: 12 }]}>
                        {String(order + 1)}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[type.prose, { color: on ? color.ink : color.chrome }]}>
                      {c.name}
                    </Text>
                    <Text style={type.metaSmall}>{c.detail}</Text>
                  </View>
                </Pressable>
              );
            })}
            {sensorStatus ? <Note>{sensorStatus}</Note> : null}
          </View>
        </ScrollView>

        <PrimaryAction label="Done" onPress={onDone} style={{ marginTop: space(3) }} />
      </View>
    </SafeAreaView>
  );
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { flex: 1, paddingHorizontal: space(5), paddingTop: space(4) },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space(4),
  },
  rateRow: { flexDirection: 'row', alignItems: 'baseline', gap: space(1.5) },
  recordChip: {
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space(4),
    minHeight: 44,
    justifyContent: 'center',
  },
  scroll: { paddingBottom: space(4), gap: space(4) },
  hint: { textAlign: 'center', marginTop: space(6) },
  heroFrame: { paddingBottom: space(1) },
  cellHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  /**
   * İki sütun `space-between` ile diziliyor: sütun aralığını yüzdeyle
   * uydurmak yerine ikinci hücrenin sağ kenarı KAPSAYICININ sağ kenarına
   * oturuyor. Böylece ızgara, üstündeki hero çerçevesiyle tam hizalanıyor —
   * `gap` + `%47` kombinasyonu hero'dan birkaç piksel içeride kalıyordu.
   */
  cellInner: { paddingHorizontal: space(3.5), paddingVertical: space(3) },
  footer: { paddingBottom: space(2) },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: space(3),
    minHeight: 44,
  },
  chooseLink: {
    fontFamily: 'BarlowCondensed_600SemiBold',
    fontSize: 13,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: color.ink,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.chrome,
    paddingBottom: 2,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
    minHeight: 44,
  },
  pickDisabled: { opacity: 0.35 },
  derivedRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space(3),
    paddingVertical: space(2.5),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
  },
  derivedValue: { flexDirection: 'row', alignItems: 'baseline', gap: space(1.5) },
  soundFrame: { paddingBottom: space(2) },
  soundStats: {
    flexDirection: 'row',
    gap: space(3),
    marginTop: space(3),
    paddingTop: space(2.5),
    borderTopWidth: hairlineWidth,
    borderTopColor: color.hairlineFaint,
  },
  soundActions: { flexDirection: 'row', gap: space(3), marginTop: space(3) },
  calibrationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2.5),
    marginTop: space(3),
  },
  calButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    backgroundColor: color.groundAlt,
  },
  pickMark: {
    width: 22,
    height: 22,
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
