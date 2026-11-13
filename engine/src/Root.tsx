import "./index.css";
import { Composition, Folder } from "remotion";
import { AdVideo, calculateAdMetadata, FPS } from "./AdVideo/AdVideo";
import { sampleProps } from "./AdVideo/sample";
import { adVideoSchema } from "./AdVideo/schema";
import { Placeholder } from "./dev/Placeholder";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AdVideo"
        component={AdVideo}
        schema={adVideoSchema}
        defaultProps={sampleProps}
        calculateMetadata={calculateAdMetadata}
        durationInFrames={FPS * 20}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Folder name="Dev">
        <Composition
          id="Placeholder"
          component={Placeholder}
          durationInFrames={FPS * 20}
          fps={FPS}
          width={1080}
          height={1920}
        />
      </Folder>
    </>
  );
};
