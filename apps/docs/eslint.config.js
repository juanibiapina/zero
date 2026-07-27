import base from "@zero/eslint-config";
import astro from "eslint-plugin-astro";

export default [{ ignores: [".astro"] }, ...base, ...astro.configs.recommended];
