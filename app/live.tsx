import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore, ALL_PIDS } from '../src/state/store';
import { orderedCards } from '../src/data/cardOrder';
import { getPidDefinition } from '../src/obd/pids';
import { getChannel, SELECTABLE_SENSOR_CHANNELS } from '../src/data/channels';
import { deriveLive, type DerivedReading } from '../src/analysis/live';
import { VehicleChrome } from '../src/ui/VehicleChrome';
import { DragGrid } from '../src/ui/DragGrid';
import { CYCLE_STEPS } from '../src/cycle/steps';
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
  const cycle = useAppStore((s) => s.cycle);
  const startCycle = useAppStore((s) => s.startCycle);
  const advanceCycle = useAppStore((s) => s.advanceCycle);
  const stopCycle = useAppStore((s) => s.stopCycle);
  const sampleRate = useAppStore((s) => s.sampleRate);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const togglePid = useAppStore((s) => s.togglePid);
  const isPidSupported = useAppStore((s) => s.isPidSupported);
  const selectedSensorChannels = useAppStore((s) => s.selectedSensorChannels);
  const toggleSensorChannel = useAppStore((s) => s.toggleSensorChannel);
  const sensorStatus = useAppStore((s) => s.sensorStatus);

  const [picking, setPicking] = useState(false);
  /**
   * Cycle'ın ön-bilgi ekranı. "Guided" düğmesi doğrudan başlatmıyordu ve
   * bu yanlıştı: 9 adımlık, soğuk motor isteyen, içinde tam gaz çekiş ve
   * frensiz yavaşlama olan bir protokole tek dokunuşla, hiçbir şey
   * okumadan giriliyordu — talimatları sürücü ilk kez ARAÇ HAREKET
   * HÂLİNDEYKEN görüyordu. Ne yapacağını yola çıkmadan önce bilmesi
   * gerekiyor.
   */
  const [preflight, setPreflight] = useState(false);
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

  if (preflight) {
    return (
      <CyclePreflight
        coolantC={latest(liveSeries['05'])}
        canStart={!notConnected}
        onStart={() => {
          setPreflight(false);
          void startCycle();
        }}
        onCancel={() => setPreflight(false)}
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

          <View style={styles.topActions}>
            {/*
              Cycle çalışırken Record düğmesi gizleniyor: cycle zaten bir
              kayıttır, ikinci bir "kaydı durdur" düğmesi iki farklı şeyi
              durduruyormuş gibi görünürdü.
            */}
            {!cycle && (
              <Pressable
                style={[styles.recordChip, isRecording && styles.recordChipOn]}
                onPress={() => (isRecording ? stopRecording() : startRecording())}
                disabled={notConnected}
              >
                <StatusDot
                  text={isRecording ? 'Recording' : 'Record'}
                  tint={isRecording ? color.alert : color.chrome}
                />
              </Pressable>
            )}

            {!isRecording && !cycle && (
              <Pressable
                style={styles.recordChip}
                onPress={() => setPreflight(true)}
                disabled={notConnected}
              >
                <Text style={[type.status, { color: notConnected ? color.muted : color.chrome }]}>
                  Guided
                </Text>
              </Pressable>
            )}
          </View>
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

          {selectedPids.length === 0 && !cycle && (
            <Text style={[type.meta, styles.hint]}>No channels selected.</Text>
          )}

          {cycle && (
            <CyclePanel
              state={cycle}
              onDone={() => advanceCycle(false)}
              onSkip={() => advanceCycle(true)}
              onStop={() => void stopCycle()}
            />
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

            Cycle çalışırken ızgara gizleniyor: o an ekranın sahibi
            talimattır, sürücünün araması gereken tek şey odur.
          */}
          {!cycle && <DragGrid
            cards={cards}
            onReorder={moveCard}
            onDragStateChange={setDragging}
            renderHero={(key) => (
              <HeroChannel channelKey={key} series={liveSeries[key] ?? []} />
            )}
            renderCell={(key) => (
              <CellChannel channelKey={key} series={liveSeries[key] ?? []} />
            )}
          />}

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


/** Bir serinin son değeri. */
function latest(series: readonly { ts: number; value: number }[] | undefined): number | null {
  if (!series || series.length === 0) return null;
  return series[series.length - 1].value;
}

/**
 * Motorun "soğuk sayılmayı" bıraktığı sıcaklık.
 *
 * Cycle'ın ilk üç adımının bütün değeri günün ilk çalıştırmasında: soğuk
 * rölanti devri, ısınma zenginleştirmesi ve termostat eğrisi başka hiçbir
 * yerde alınamıyor. Motor zaten ısınmışsa o adımlar çalışır ama ölçmesi
 * gereken şeyi ölçmez — ve bunu sessizce yapar. Çalışma sıcaklığı 85 °C;
 * 50 °C "bu araç bugün zaten çalıştı" demek için fazlasıyla yeterli.
 */
const COLD_ENGINE_MAX_C = 50;

/**
 * Cycle'ın ön-bilgi ekranı.
 *
 * NEDEN VAR: sürücünün ne yapacağını YOLA ÇIKMADAN ÖNCE bilmesi gerekiyor.
 * Cycle 9 adım; içinde durur hâlden tam gazla 100'e çıkış ve frene basmadan
 * 80'den 40'a yavaşlama var. Bunları canlı talimat olarak, araç hareket
 * hâlindeyken ilk kez okumak hem kötü bir deneyim hem gereksiz bir risk.
 *
 * İkinci iş: soğuk motor uyarısı. Adımların üçü yalnızca günün ilk
 * çalıştırmasında anlamlı ve bunu başlamadan önce söylemek, sonradan
 * "neden bu ölçüm boş çıktı" sorusunu tamamen ortadan kaldırıyor.
 */
function CyclePreflight({
  coolantC,
  canStart,
  onStart,
  onCancel,
}: {
  coolantC: number | null;
  canStart: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const holdMinutes = Math.round(
    CYCLE_STEPS.reduce((total, s) => total + s.holdSeconds, 0) / 60,
  );
  const alreadyWarm = coolantC !== null && coolantC > COLD_ENGINE_MAX_C;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <VehicleChrome />

      <View style={styles.body}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <SectionRule label="Guided test cycle" meta={`${CYCLE_STEPS.length} steps`} />
          <Note>
            Some measurements need conditions an ordinary drive never produces — a cold start, a
            steady cruise held in one gear, a clean coast-down. This cycle sets them up in order,
            and narrows polling to just the channels each step needs so the sensors are sampled
            fast enough to actually be measured.
          </Note>

          <View style={styles.preflightFacts}>
            <PreflightFact
              label="Time"
              value={`About ${holdMinutes} minutes of held measurements, plus driving between them.`}
            />
            <PreflightFact
              label="Engine"
              value="Start cold — ignition on, engine not yet running. Three steps only measure anything on the day's first start."
            />
            <PreflightFact
              label="Road"
              value="You will need a clear, level stretch: one full-throttle pull to 100 km/h and one coast-down from 80 to 40 with no braking."
            />
            <PreflightFact
              label="Phone"
              value="Keep the app open and the screen on. Time spent in the background is not recorded."
            />
          </View>

          {/*
            Uyarı yalnızca ÖLÇÜLMÜŞ bir sıcaklık varsa çıkıyor. Veri yokken
            "motor soğuk mu" diye tahmin etmek, yanlış uyarı üretip
            uyarının kendisini değersizleştirirdi.
          */}
          {alreadyWarm && (
            <View style={styles.preflightWarning}>
              <Text style={[type.status, { color: color.caution, fontSize: 12 }]}>
                ENGINE IS ALREADY WARM
              </Text>
              <Text style={[type.meta, { marginTop: space(1.5), lineHeight: 18 }]}>
                {`Coolant is at ${Math.round(coolantC)} °C, so this is not a cold start. Cold idle, ` +
                  'oxygen sensor and warm-up steps will run, but they will not measure what they ' +
                  'are for. Everything after them is unaffected.'}
              </Text>
            </View>
          )}

          <View style={{ marginTop: space(5) }}>
            <SectionRule label="Steps" />
            {CYCLE_STEPS.map((step, i) => (
              <View key={step.id} style={styles.preflightStep}>
                <Text style={[type.status, styles.preflightStepNumber]}>{String(i + 1)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[type.prose, { color: color.ink }]}>{step.title}</Text>
                  <Text style={[type.metaSmall, { marginTop: space(0.75), lineHeight: 15 }]}>
                    {step.instruction}
                  </Text>
                </View>
              </View>
            ))}
          </View>

          <Note>
            You can skip a step you cannot do, and end the cycle at any point. Whatever was
            recorded up to then is kept.
          </Note>
        </ScrollView>

        <View style={styles.preflightActions}>
          <GhostAction label="Back" onPress={onCancel} style={{ flex: 1 }} />
          <PrimaryAction
            label="Start cycle"
            onPress={onStart}
            disabled={!canStart}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

function PreflightFact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.preflightFact}>
      <Label small>{label}</Label>
      <Text style={[type.meta, { marginTop: space(1), lineHeight: 18 }]}>{value}</Text>
    </View>
  );
}

/**
 * Rehberli test cycle'ının paneli.
 *
 * Ekranın sahibi TALİMAT. Sürücü araç kullanırken buraya bakacak; okunacak
 * tek cümle, sağlanması gereken koşullar ve kalan süre dışındaki her şey
 * gürültü. Koşullar canlı yeşilleniyor ki sürücü "yeterince yavaş mıyım"
 * sorusunu ekrana bakarak cevaplayabilsin.
 */
function CyclePanel({
  state,
  onDone,
  onSkip,
  onStop,
}: {
  state: NonNullable<ReturnType<typeof useAppStore.getState>['cycle']>;
  onDone: () => void;
  onSkip: () => void;
  onStop: () => void;
}) {
  const step = CYCLE_STEPS[state.stepIndex];
  const { progress } = state;
  const remaining =
    step.holdSeconds > 0 ? Math.max(0, Math.ceil(step.holdSeconds - progress.heldSeconds)) : null;

  return (
    <View style={{ marginTop: space(2) }}>
      <SectionRule
        label={`Step ${state.stepIndex + 1} of ${CYCLE_STEPS.length}`}
        meta={step.title}
      />

      <Text style={[type.headline, { color: color.ink, marginTop: space(3) }]}>
        {step.instruction}
      </Text>

      {/* İlerleme: çubuk değil hairline — tasarımın dili bu. */}
      <View style={styles.cycleTrack}>
        <View style={[styles.cycleFill, { flex: Math.max(0.001, progress.fraction) }]} />
        <View style={{ flex: Math.max(0.001, 1 - progress.fraction) }} />
      </View>

      <View style={styles.cycleConditions}>
        {progress.conditions.map((c) => (
          <Text
            key={c.label}
            style={[type.metaSmall, { color: c.met ? color.linked : color.caution }]}
          >
            {`${c.met ? '✓' : '·'} ${c.label}${c.value === null ? '' : ` — ${c.value.toFixed(0)}`}`}
          </Text>
        ))}
        {remaining !== null ? (
          <Text style={[type.metaSmall, { color: color.chrome }]}>{`${remaining} s left`}</Text>
        ) : null}
      </View>

      <Text style={[type.meta, { marginTop: space(2.5), lineHeight: 16 }]}>{step.measures}</Text>

      {/*
        Ekran kapanırsa iOS uygulamayı askıya alır ve adım sayacı donar.
        Arka plan modları bir sonraki derlemeye kadar yok.
      */}
      <Text style={[type.metaSmall, { marginTop: space(2), color: color.caution }]}>
        Keep this screen open — the step timer stops if the app is suspended.
      </Text>

      {/*
        "Done, next" ile "Skip step" AYNI ŞEY DEĞİL.
        7 Eylül 2026 saha testinde ikisi de aynı çağrıyı yapıyordu: kontak
        adımı kurallara uygun tamamlandı (motor kapalı, 11.4 V veride
        duruyor) ama "atlandı" diye kaydedildi, akü vital'i hiç üretilmedi
        ve rapor "yeterli veri yok" dedi. Ölçüm elde, kayıt çöpte.
      */}
      <View style={styles.cycleActions}>
        {step.manualAdvance ? (
          <GhostAction label="Done, next" onPress={onDone} style={{ flex: 1 }} />
        ) : (
          <GhostAction label="Skip step" onPress={onSkip} style={{ flex: 1 }} />
        )}
        <GhostAction label="End cycle" onPress={onStop} tint={color.alert} style={{ flex: 1 }} />
      </View>
    </View>
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
  topActions: { flexDirection: 'row', gap: space(2.5) },
  preflightFacts: { marginTop: space(4), gap: space(3.5) },
  preflightFact: {
    paddingBottom: space(3),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
  },
  preflightWarning: {
    marginTop: space(4),
    padding: space(3),
    borderWidth: hairlineWidth,
    borderColor: color.caution,
    backgroundColor: color.groundAlt,
  },
  preflightStep: {
    flexDirection: 'row',
    gap: space(3),
    paddingVertical: space(2.5),
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.hairlineFaint,
  },
  preflightStepNumber: { color: color.muted, fontSize: 12, width: 16 },
  preflightActions: { flexDirection: 'row', gap: space(3), paddingVertical: space(3) },
  cycleTrack: {
    flexDirection: 'row',
    height: hairlineWidth * 3,
    backgroundColor: color.hairlineFaint,
    marginTop: space(3),
  },
  cycleFill: { backgroundColor: color.linked },
  cycleConditions: { marginTop: space(2.5), gap: space(1) },
  cycleActions: { flexDirection: 'row', gap: space(3), marginTop: space(4) },
  recordChip: {
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    paddingHorizontal: space(4),
    minHeight: 44,
    justifyContent: 'center',
  },
  /**
   * Kayıt durumu: kırmızıyı 1px hairline kenarlık olarak taşımak zemin
   * üzerinde ~2.8:1 kalıyordu. Bunun yerine 3px kırmızı DOLU sol bar —
   * kırmızı yine sadece dolgu, kenarlığın geri kalanı nötr.
   */
  recordChipOn: {
    borderLeftWidth: 3,
    borderLeftColor: color.alert,
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
  pickMark: {
    width: 22,
    height: 22,
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
