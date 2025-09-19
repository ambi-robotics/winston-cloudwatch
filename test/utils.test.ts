import { stringify } from '../lib/utils';

describe('utils', () => {
  describe('stringify', () => {
    it('stringifies an object', () => {
      const object = { answer: 42 };
      expect(stringify(object)).toBe(JSON.stringify(object, null, '  '));
    });

    it('stringifies an Error instance', () => {
      const error = new Error('uh-oh');
      const result = JSON.parse(stringify(error));
      expect(result.message).toBe('uh-oh');
      expect(typeof result.stack).toBe('string');
    });

    it('handles circular objects', () => {
      const circular: any = {};
      const child = { circular };
      circular.child = child;

      const stringifyFn = () => {
        stringify(circular);
      };

      expect(stringifyFn).not.toThrow();
    });
  });
});