import esLint from '@eslint/js';
import tsEsLint from 'typescript-eslint';

export default tsEsLint.config(
    {
        ignores: ['dist', '.idea', '.wrangler'],
    },
    esLint.configs.recommended,
    ...tsEsLint.configs.strict,
    {
        ...tsEsLint.configs.disableTypeChecked,
        files: ['**/*.js', '**/*.mjs', '**/*.ts', '**/*.mts'],
        rules: {
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
