import type { BrowserContext } from "@playwright/test";

// Test-only synthetic video. Never calls the host's actual camera or microphone.
export async function syntheticQrCamera(context: BrowserContext, image: string, delayed = false) {
  await context.addInitScript(
    ({ image, delayed }) => {
      const state = window as typeof window & {
        cameraProbe: {
          requests: number;
          constraints: MediaStreamConstraints[];
          tracks: MediaStreamTrack[];
          release: () => void;
        };
      };
      state.cameraProbe = { requests: 0, constraints: [], tracks: [], release: () => {} };
      Object.defineProperty(window, "BarcodeDetector", { value: undefined, configurable: true });
      // Remove the property entirely: the library deliberately uses `in` detection.
      Reflect.deleteProperty(window, "BarcodeDetector");
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async (constraints: MediaStreamConstraints) => {
          state.cameraProbe.requests++;
          state.cameraProbe.constraints.push(constraints);
          if (delayed)
            await new Promise<void>((resolve) => {
              state.cameraProbe.release = resolve;
            });
          const img = new Image();
          img.src = image;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 480;
          const context = canvas.getContext("2d")!;
          const draw = () => {
            context.fillStyle = "white";
            context.fillRect(0, 0, 480, 480);
            context.drawImage(img, 90, 90, 300, 300);
          };
          draw();
          const stream = canvas.captureStream(5),
            timer = setInterval(draw, 100);
          for (const track of stream.getTracks()) {
            state.cameraProbe.tracks.push(track);
            const stop = track.stop.bind(track);
            track.stop = () => {
              clearInterval(timer);
              stop();
            };
          }
          return stream;
        },
        configurable: true,
      });
    },
    { image, delayed },
  );
}
