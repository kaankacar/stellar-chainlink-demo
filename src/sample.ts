// The one signed testnet report Chainlink publishes: ETH/USD schema v3, 736 bytes, expired 2026-05-03.
// Vite reads the fixture as text at build time, so the page and the contract tests share one copy.
// This file sits outside src/lib on purpose: tsconfig.node.json compiles src/lib without the vite/client types.
import sampleHex from '../contracts/two-clocks/fixtures/streams-eth-usd-testnet-sample.hex?raw';

export const SAMPLE_REPORT_HEX: string = sampleHex.trim();

/** The low byte of the price word. Flipping it keeps the layout valid and breaks the signatures. */
export const SAMPLE_TAMPER_BYTE = 479;
