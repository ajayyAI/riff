import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The compiler memoizes for us, which is why nothing in src/ hand-writes
  // useMemo, useCallback or React.memo.
  reactCompiler: true,
  // The dev overlay sits in the bottom-left corner, which is where the timeline
  // puts its first rows. Turning it off keeps a full-window editor usable while
  // developing it.
  devIndicators: false,
};

export default nextConfig;
