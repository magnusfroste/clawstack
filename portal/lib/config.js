'use strict';

const ADMIN_USER  = process.env.ADMIN_USER  || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS  || 'changeme';
const BASE_DOMAIN = process.env.BASE_DOMAIN || '';
const OPENCLAW_IMAGE    = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:latest';
const INSTANCES_DIR     = '/instances';
const INSTANCES_HOST_DIR = process.env.INSTANCES_HOST_DIR || '/opt/clawstack/instances';
const CONFIG_DIR        = '/clawstack-config';
const ALLOWED_CONFIG_FILES = ['docker-compose.yml', '.env', 'Caddyfile'];
const CLAW_DEFAULTS_FILE   = '/data/claw-defaults.json';

const PAPERCLIP_URL       = 'http://paperclip:3100';
const PAPERCLIP_CONTAINER = 'clawstack-paperclip-1';
const PAPERCLIP_DB        = 'clawstack-paperclip-db-1';

const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'gemini', 'private'];
const MODEL_PRESETS = {
  openrouter: 'google/gemini-2.5-pro-preview',
  openai:     'gpt-4o',
  anthropic:  'claude-sonnet-4-6',
  gemini:     'gemini-2.5-pro-preview',
  private:    'my-model',
};
const NO_KEY_PROVIDERS = new Set(['private']);

const PROVIDER_CONFIGS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                            api: 'openai-completions' },
  openai:     { baseUrl: 'https://api.openai.com/v1',                               api: 'openai-completions' },
  anthropic:  { baseUrl: 'https://api.anthropic.com',                               api: 'anthropic-messages'  },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai-completions' },
  private:    { baseUrl: '',                                                          api: 'openai-completions' },
};

const BASELINE_CLAW_DEFAULTS = {
  agents: {
    defaults: {
      maxConcurrent: 4,
      subagents: { maxConcurrent: 8 },
      compaction: { mode: 'default', reserveTokensFloor: 40000 },
      contextPruning: {
        mode: 'cache-ttl', ttl: '45m', keepLastAssistants: 2,
        minPrunableToolChars: 12000,
        hardClear: { enabled: true, placeholder: '[Old tool result cleared]' },
      },
    }
  },
  browser: { enabled: true, headless: true, noSandbox: true },
  session: { dmScope: 'per-channel-peer' },
};

module.exports = {
  ADMIN_USER, ADMIN_PASS, BASE_DOMAIN, OPENCLAW_IMAGE,
  INSTANCES_DIR, INSTANCES_HOST_DIR, CONFIG_DIR, ALLOWED_CONFIG_FILES, CLAW_DEFAULTS_FILE,
  PAPERCLIP_URL, PAPERCLIP_CONTAINER, PAPERCLIP_DB,
  PROVIDERS, MODEL_PRESETS, NO_KEY_PROVIDERS, PROVIDER_CONFIGS, BASELINE_CLAW_DEFAULTS,
};
