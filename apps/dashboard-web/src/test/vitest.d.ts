// Bring the jest-dom matcher augmentation (toBeInTheDocument, etc.) into the
// TypeScript program so component tests typecheck. The runtime registration
// lives in vitest.setup.ts.
import "@testing-library/jest-dom/vitest";
