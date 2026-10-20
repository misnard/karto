import { describe, expect, it } from 'vitest';
import { parseServerUrl } from './state.ts';

describe('parseServerUrl', () => {
  it.each([
    ['https://karto.example.fr', 'https://karto.example.fr'],
    ['  https://karto.example.fr/  ', 'https://karto.example.fr'],
    ['https://example.fr/karto//', 'https://example.fr/karto'],
    ['https://karto.example.fr:8443', 'https://karto.example.fr:8443'],
    ['HTTPS://Karto.Example.FR', 'https://karto.example.fr'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8796/', 'http://127.0.0.1:8796'],
  ])('accepts %j', (input, expected) => {
    expect(parseServerUrl(input)).toBe(expected);
  });

  it.each([
    'http://karto.example.fr', // plain http off this machine
    'http://192.168.1.10:8787',
    'karto.example.fr',
    'ftp://karto.example.fr',
    'https://user:pass@karto.example.fr',
    'https://karto.example.fr/?x=1',
    'https://karto.example.fr/#x',
    '',
  ])('refuses %j', (input) => {
    expect(parseServerUrl(input)).toBeNull();
  });
});
