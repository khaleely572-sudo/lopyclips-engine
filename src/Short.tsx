import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Series,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Montserrat';
import data from './data.json';

const {fontFamily} = loadFont('normal', {weights: ['800', '900'], subsets: ['latin']});

type Word = {t: number; e: number; w: string};
type Chunk = {s: number; e: number; words: Word[]};
export type Segment = {
  file: string;
  frames: number;
  round: number | null;
  label: string;
  hit: number | null;
  hitLabel: string | null;
  chunks: Chunk[];
  mutes: number[][];
  zooms?: number[];
};
export type Rect = {x: number; y: number; w: number; h: number};
export type ShortStyle = {
  accent: string;
  done: string;
  captionSize: number;
  uppercase: boolean;
  layout: 'full' | 'stack';
  facecam: Rect | null;
  brand: string | null;
};
export type ShortVideo = {title: string; doneStart: number; pips?: number; segments: Segment[]};
export type ShortProps = {video: ShortVideo; credit: string; style?: Partial<ShortStyle>};

export const DEFAULT_STYLE: ShortStyle = {
  accent: '#FFE600',
  done: '#2BE06A',
  captionSize: 92,
  uppercase: true,
  layout: 'full',
  facecam: null,
  brand: null,
};

const ROUNDS = 5;
const VIDEO_H = (1080 * 9) / 16;
const SOURCE_W = 1920;
const SOURCE_H = 1080;
const STACK_TOP = 330;
const STACK_GAP = 12;
const STACK_FACE_MAX_H = 560;

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const bumpAt = (frame: number, at: number) => interpolate(frame - at, [0, 4, 16], [0, 1, 0], clamp);

/** Where things sit for each layout. The stacked layout shows the full frame above a facecam crop. */
const geometry = (style: ShortStyle) => {
  if (style.layout === 'stack' && style.facecam) {
    const faceScale = 1080 / style.facecam.w;
    const faceH = Math.min(STACK_FACE_MAX_H, style.facecam.h * faceScale);
    const faceTop = STACK_TOP + VIDEO_H + STACK_GAP;
    return {stacked: true, videoTop: STACK_TOP, headerTop: 110, captionTop: faceTop - 130, faceTop, faceH, faceScale};
  }
  return {stacked: false, videoTop: 560, headerTop: 200, captionTop: 1230, faceTop: 0, faceH: 0, faceScale: 1};
};

const Captions: React.FC<{chunks: Chunk[]; style: ShortStyle; top: number}> = ({chunks, style, top}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const chunk = chunks.find((c) => t >= c.s && t < c.e);
  if (!chunk) {
    return null;
  }
  const pop = spring({frame: frame - chunk.s * fps, fps, config: {damping: 12, mass: 0.4}});
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 60,
        right: 60,
        height: 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        alignContent: 'center',
        columnGap: 44,
        transform: `scale(${interpolate(pop, [0, 1], [0.8, 1])})`,
      }}
    >
      {chunk.words.map((w, i) => {
        const active = t >= w.t && t < w.e;
        return (
          <span
            key={i}
            style={{
              fontFamily,
              fontWeight: 900,
              fontSize: style.captionSize,
              lineHeight: 1.1,
              textTransform: style.uppercase ? 'uppercase' : 'none',
              color: active ? style.accent : 'white',
              WebkitTextStroke: '14px black',
              paintOrder: 'stroke fill',
              textShadow: '0 8px 24px rgba(0,0,0,0.6)',
              transform: `scale(${active ? 1.08 : 1})`,
              display: 'inline-block',
            }}
          >
            {w.w}
          </span>
        );
      })}
    </div>
  );
};

const Header: React.FC<{seg: Segment; doneBefore: number; title: string; pips: number; style: ShortStyle; top: number; compact: boolean}> = ({
  seg,
  doneBefore,
  title,
  pips,
  style,
  top,
  compact,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const hitFrame = seg.hit === null ? null : seg.hit * fps;
  const justHit = hitFrame !== null && frame >= hitFrame;
  const label = justHit && seg.hitLabel ? seg.hitLabel : seg.label;
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 26,
        fontFamily,
      }}
    >
      <div
        style={{
          fontWeight: 900,
          fontSize: 66,
          color: 'white',
          letterSpacing: 1,
          WebkitTextStroke: '10px black',
          paintOrder: 'stroke fill',
        }}
      >
        {title}
      </div>
      {compact ? null : (
        <div style={{display: 'flex', gap: 22}}>
          {Array.from({length: pips}).map((_, i) => {
            const isCurrent = seg.round !== null && i === seg.round - 1;
            const done = i < doneBefore || (isCurrent && justHit);
            const pop =
              isCurrent && hitFrame !== null
                ? spring({frame: frame - hitFrame, fps, config: {damping: 7, mass: 0.5}})
                : 1;
            const pulse = isCurrent && !justHit ? 1 + 0.06 * Math.sin(frame / 4) : 1;
            return (
              <div
                key={i}
                style={{
                  width: 84,
                  height: 84,
                  borderRadius: 42,
                  border: `7px solid ${done ? style.done : isCurrent ? style.accent : 'rgba(255,255,255,0.55)'}`,
                  background: done ? style.done : 'rgba(0,0,0,0.55)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 900,
                  fontSize: 44,
                  color: done ? '#06240f' : 'white',
                  transform: `scale(${done && isCurrent ? interpolate(pop, [0, 1], [1.7, 1]) : pulse})`,
                }}
              >
                {done ? '✓' : i + 1}
              </div>
            );
          })}
        </div>
      )}
      <div
        style={{
          fontWeight: 800,
          fontSize: 44,
          color: justHit ? '#06240f' : 'black',
          background: justHit ? style.done : style.accent,
          padding: '10px 30px',
          borderRadius: 16,
        }}
      >
        {label}
      </div>
    </div>
  );
};

const SegmentView: React.FC<{seg: Segment; doneBefore: number; title: string; pips: number; credit: string; style: ShortStyle}> = ({
  seg,
  doneBefore,
  title,
  pips,
  credit,
  style,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const src = staticFile(seg.file);
  const layout = geometry(style);
  const hitBump = seg.hit === null ? 0 : bumpAt(frame, seg.hit * fps);
  const zoomBump = Math.max(0, ...(seg.zooms ?? []).map((at) => bumpAt(frame, at * fps)));
  const flash = interpolate(frame, [0, 6], [0.75, 0], clamp);
  const volume = (f: number) => {
    const t = f / fps;
    if (seg.mutes.some(([a, b]) => t >= a && t < b)) {
      return 0;
    }
    return interpolate(f, [0, 3, seg.frames - 3, seg.frames], [0, 1, 1, 0], clamp);
  };
  return (
    <AbsoluteFill style={{backgroundColor: '#0b0b10'}}>
      <AbsoluteFill style={{filter: 'blur(36px) brightness(0.4)', transform: 'scale(1.15)'}}>
        <OffthreadVideo muted src={src} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: layout.videoTop,
          left: 0,
          width: 1080,
          height: VIDEO_H,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
          transform: `scale(${1 + 0.05 * hitBump + 0.04 * zoomBump}) translateX(${Math.sin(frame * 2.4) * 9 * hitBump}px)`,
        }}
      >
        <OffthreadVideo src={src} volume={volume} style={{width: '100%', height: '100%'}} />
      </div>
      {layout.stacked && style.facecam ? (
        <div style={{position: 'absolute', top: layout.faceTop, left: 0, width: 1080, height: layout.faceH, overflow: 'hidden'}}>
          <OffthreadVideo
            muted
            src={src}
            style={{
              position: 'absolute',
              width: SOURCE_W * layout.faceScale,
              height: SOURCE_H * layout.faceScale,
              left: -style.facecam.x * layout.faceScale,
              top: -style.facecam.y * layout.faceScale,
              maxWidth: 'none',
            }}
          />
        </div>
      ) : null}
      <Header seg={seg} doneBefore={doneBefore} title={title} pips={pips} style={style} top={layout.headerTop} compact={layout.stacked} />
      <Captions chunks={seg.chunks} style={style} top={layout.captionTop} />
      <div
        style={{
          position: 'absolute',
          top: layout.stacked ? layout.faceTop + layout.faceH + 16 : 1490,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily,
          fontWeight: 800,
          fontSize: 30,
          color: 'rgba(255,255,255,0.75)',
        }}
      >
        {style.brand ? <div style={{fontWeight: 900, letterSpacing: 10, color: style.accent, marginBottom: 6}}>{style.brand}</div> : null}
        {credit}
      </div>
      <AbsoluteFill style={{backgroundColor: 'white', opacity: flash}} />
    </AbsoluteFill>
  );
};

/** One Short, driven entirely by its props. This is what the automation engine renders. */
export const ShortView: React.FC<ShortProps> = ({video, credit, style}) => {
  const merged: ShortStyle = {...DEFAULT_STYLE, ...style};
  let done = video.doneStart;
  return (
    <Series>
      {video.segments.map((seg, i) => {
        // Earlier clips count as done even when a segment has no reveal moment.
        const doneBefore = seg.round === null ? done : Math.max(done, seg.round - 1);
        if (seg.round !== null && seg.hit !== null) {
          done = seg.round;
        }
        return (
          <Series.Sequence key={i} durationInFrames={seg.frames}>
            <SegmentView seg={seg} doneBefore={doneBefore} title={video.title} pips={video.pips ?? ROUNDS} credit={credit} style={merged} />
          </Series.Sequence>
        );
      })}
    </Series>
  );
};

/** A Short from the hand-built data file, looked up by id. */
export const Short: React.FC<{videoId: string}> = ({videoId}) => {
  const video = (data.videos.find((v) => v.id === videoId) ?? data.videos[0]) as ShortVideo;
  return <ShortView video={video} credit={data.credit} />;
};
