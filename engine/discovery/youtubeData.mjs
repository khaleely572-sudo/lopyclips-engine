import {youtube as youtubeApi} from '@googleapis/youtube';

export const parseIsoDuration = (iso) => {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? '');
  if (!match) {
    return null;
  }
  const [, d, h, m, s] = match.map((part) => Number(part) || 0);
  return d * 86400 + h * 3600 + m * 60 + s;
};

/** Thin wrapper over the official Data API. `onCall` is told about every request so quota use can be counted. */
export const createYouTubeData = (auth, onCall = () => {}) => {
  const api = youtubeApi({version: 'v3', auth});
  return {
    async resolveChannel({handle, channelId}) {
      onCall('general', 1);
      const base = {part: ['snippet', 'contentDetails']};
      const res = await api.channels.list(channelId ? {...base, id: [channelId]} : {...base, forHandle: handle});
      const item = res.data.items?.[0];
      return item ? {channelId: item.id, title: item.snippet?.title ?? null, uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null} : null;
    },
    /** The channel's newest upload IDs, or null when the channel has no public uploads playlist. */
    async recentUploadIds(playlistId, max) {
      onCall('general', 1);
      try {
        const res = await api.playlistItems.list({part: ['contentDetails'], playlistId, maxResults: max});
        return (res.data.items ?? []).map((item) => item.contentDetails?.videoId).filter(Boolean);
      } catch (err) {
        if (err?.response?.status === 404) {
          return null;
        }
        throw err;
      }
    },
    async videoDetails(ids) {
      if (ids.length === 0) {
        return [];
      }
      onCall('general', 1);
      const res = await api.videos.list({part: ['snippet', 'contentDetails', 'liveStreamingDetails'], id: ids});
      return (res.data.items ?? []).map((video) => ({
        videoId: video.id,
        title: video.snippet?.title ?? '',
        channelTitle: video.snippet?.channelTitle ?? null,
        publishedAt: video.snippet?.publishedAt ?? null,
        liveState: video.snippet?.liveBroadcastContent ?? 'none',
        durationS: parseIsoDuration(video.contentDetails?.duration),
        wasLive: Boolean(video.liveStreamingDetails),
        language: video.snippet?.defaultAudioLanguage ?? null,
      }));
    },
  };
};
