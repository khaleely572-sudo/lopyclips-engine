import React from 'react';
import {Composition} from 'remotion';
import {Short, ShortView, type ShortProps, type ShortVideo} from './Short';
import data from './data.json';

const framesOf = (video: ShortVideo) => Math.max(1, video.segments.reduce((sum, s) => sum + s.frames, 0));

export const Root: React.FC = () => {
  return (
    <>
      {data.videos.map((video) => (
        <Composition
          key={video.id}
          id={video.id}
          component={Short}
          defaultProps={{videoId: video.id}}
          width={1080}
          height={1920}
          fps={data.fps}
          durationInFrames={framesOf(video as ShortVideo)}
        />
      ))}
      <Composition
        id="LopyShort"
        component={ShortView}
        defaultProps={{video: data.videos[0] as ShortVideo, credit: data.credit} as ShortProps}
        calculateMetadata={({props}) => ({durationInFrames: framesOf(props.video)})}
        width={1080}
        height={1920}
        fps={data.fps}
        durationInFrames={framesOf(data.videos[0] as ShortVideo)}
      />
    </>
  );
};
