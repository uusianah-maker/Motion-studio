/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";
import { enableTailwind } from '@remotion/tailwind-v4';

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
Config.overrideBundlerConfig(enableTailwind);

// Percepatan render (diukur 11 Nov 2026, i5-12500H + GTX 1650, 300 frame a3):
// default 35,7 dtk -> GPU (ANGLE) 26,9 dtk -> + concurrency 12: 23,4 dtk.
// Hasil GPU identik dengan CPU (PSNR rata-rata 47 dB).
Config.setChromiumOpenGlRenderer("angle");
Config.setConcurrency(12);
