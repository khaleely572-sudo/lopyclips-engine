/** Looks the engine rotates through so consecutive Shorts are not identical. Add or edit freely. */
export const STYLE_PRESETS = {
  classic: {accent: '#FFE600', done: '#2BE06A', captionSize: 92, uppercase: true},
  ice: {accent: '#5CE1FF', done: '#FFFFFF', captionSize: 92, uppercase: true},
  heat: {accent: '#FF8A1F', done: '#FFE600', captionSize: 96, uppercase: true},
  mint: {accent: '#7CFFB2', done: '#FFE600', captionSize: 88, uppercase: false},
};

/** The channel name shown on every Short. Set LOPYCLIPS_BRAND in .env to use your own. */
export const BRAND = (process.env.LOPYCLIPS_BRAND || 'LOPYCLIPS').trim().toUpperCase().slice(0, 24);

/** Pick the preset for a Short; the stacked layout is used only when the creator has a facecam rectangle set. */
export const styleFor = (shortId, creator, presetName = null) => {
  const names = Object.keys(STYLE_PRESETS);
  const name = presetName && STYLE_PRESETS[presetName] ? presetName : names[shortId % names.length];
  const facecam = creator?.facecam_rect ? JSON.parse(creator.facecam_rect) : null;
  return {name, style: {...STYLE_PRESETS[name], layout: facecam ? 'stack' : 'full', facecam, brand: BRAND}};
};
