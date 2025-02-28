import js from '@eslint/js';
import json from '@eslint/json';
import markdown from '@eslint/markdown';
import importPlugin from 'eslint-plugin-import';
import yml from 'eslint-plugin-yml';
import globals from 'globals';

export default [
	{
		ignores: ['node_modules/'],
	},
	{
		files: ['**/*.js'],
		languageOptions: {
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
			},
		},
		plugins: {
			'import': importPlugin,
		},
		rules: {
			...js.configs.recommended.rules,
			...importPlugin.flatConfigs.recommended.rules,
			'logical-assignment-operators': 'error',
			'no-new-func': 'error',
			'no-new-object': 'error',
			'no-new-wrappers': 'error',
			'no-var': 'error',
			'prefer-const': 'error',
			'no-extra-parens': 'error',
			'no-misleading-character-class': 'error',
			'no-template-curly-in-string': 'error',
			'require-atomic-updates': 'error',
			curly: ['error', 'all'],
			indent: ['error', 'tab', { SwitchCase: 1 }],
			'linebreak-style': [0, 'unix'],
			semi: ['error', 'always'],
			'no-console': 0,
			'no-unused-vars': ['warn', { varsIgnorePattern: '^_' }],
			'no-redeclare': 'warn',
			'no-unreachable': 'warn',
			'no-inner-declarations': 0,
			'comma-dangle': ['warn', 'always-multiline'],
			eqeqeq: 'error',
			'dot-notation': 'error',
			'no-else-return': 'error',
			'no-extra-bind': 'error',
			'no-labels': 'error',
			'no-floating-decimal': 'error',
			'no-lone-blocks': 'error',
			'no-loop-func': 'error',
			'no-magic-numbers': 'off',
			'no-multi-spaces': 'error',
			'no-param-reassign': 'error',
			strict: ['error', 'global'],
			quotes: ['warn', 'single', { avoidEscape: true }],
			'quote-props': ['warn', 'as-needed', { keywords: true, unnecessary: true, numbers: false }],
			'no-empty': ['error', { allowEmptyCatch: true }],
			'arrow-spacing': ['error', { before: true, after: true }],
			'prefer-arrow-callback': 'error',
			'prefer-spread': 'error',
			'prefer-template': 'error',
			'prefer-rest-params': 'error',
			'prefer-exponentiation-operator': 'error',
			'require-await': 'error',
			'arrow-parens': 'error',
			'no-use-before-define': 'error',
			'no-multiple-empty-lines': ['warn', { max: 1, maxEOF: 1 }],
			'prefer-destructuring': [
				'warn',
				{
					VariableDeclarator: { object: true, array: false },
					AssignmentExpression: { object: true, array: false },
				},
				{ enforceForRenamedProperties: false },
			],
			'space-infix-ops': 'warn',
			'object-curly-spacing': ['warn', 'always'],
			'array-bracket-spacing': ['warn', 'never', { singleValue: false, objectsInArrays: false, arraysInArrays: true }],
			'comma-spacing': ['warn', { before: false, after: true }],
			'key-spacing': ['warn', { beforeColon: false, afterColon: true }],
			'space-in-parens': ['warn', 'never'],
			'implicit-arrow-linebreak': ['warn', 'beside'],
			'function-call-argument-newline': ['warn', 'consistent'],
			'no-extra-semi': 'error',
			'padding-line-between-statements': [
				'warn',
				{ blankLine: 'always', prev: 'import', next: '*' },
				{ blankLine: 'never', prev: 'import', next: 'import' },
			],
			'import/first': 'warn',
			'import/no-unresolved': [
				'error',
				{ ignore: ['^@octokit/core$'] }, // ignore this package
			],
			'import/order': [
				'warn',
				{
					groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
					alphabetize: { order: 'asc', caseInsensitive: false },
				},
			],
		},
	},
	{
		files: ['**/*.json'],
		language: 'json/json',
		ignores: ['package-lock.json'],
		...json.configs.recommended,
	},
	{
		files: ['**/*.md'],
		language: 'markdown/gfm',
		plugins: { markdown },
		rules: {
			...markdown.configs.recommended[0].rules,
			'markdown/heading-increment': 'off',
		},

	},
	{
		files: ['**/*.{yml,yaml}'],
		ignores: ['data/*.yaml'],
		languageOptions: {
			...yml.configs['flat/standard'][1].languageOptions,
		},
		plugins: {
			...yml.configs['flat/standard'][0].plugins,
		},
		rules: {
			...yml.configs['flat/standard'][1].rules,
			...yml.configs['flat/standard'][2].rules,
			...yml.configs['flat/prettier'][2].rules,
			'yml/no-empty-mapping-value': 'off',
		},
	},
];