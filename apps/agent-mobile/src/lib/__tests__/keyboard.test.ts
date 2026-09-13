import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { refocusAfterPresentation } from '../keyboard';

describe('refocusAfterPresentation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for native autofocus, then separates blur and focus', () => {
    const input = { blur: jest.fn(), focus: jest.fn() };

    const cancel = refocusAfterPresentation(input);

    expect(input.blur).not.toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(input.blur).toHaveBeenCalledTimes(1);
    expect(input.focus).not.toHaveBeenCalled();

    jest.advanceTimersByTime(50);
    expect(input.focus).toHaveBeenCalledTimes(1);

    cancel();
  });

  it('cancels focus when the surface closes first', () => {
    const input = { blur: jest.fn(), focus: jest.fn() };

    const cancel = refocusAfterPresentation(input);
    cancel();
    jest.advanceTimersByTime(100);

    expect(input.focus).not.toHaveBeenCalled();
  });
});
