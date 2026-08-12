import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, { ignores: ['.next/**', 'next-env.d.ts', 'node_modules/**'] });
