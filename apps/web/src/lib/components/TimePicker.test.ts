import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { timePickValues, type TimePickContext, type TimePickInput } from '#lib/time-picker.ts';
import TimePicker from './TimePicker.svelte';

function context() {
  return {
    set: vi.fn<TimePickContext['set']>(),
    show: vi.fn<TimePickContext['show']>(),
    edit: vi.fn<TimePickContext['edit']>(),
  } satisfies TimePickContext;
}

function values(over: Partial<TimePickInput> = {}, ctx: TimePickContext = context()) {
  return timePickValues(
    {
      title: 'Quiet hours end',
      value: '07:30',
      disabled: false,
      h12: false,
      open: true,
      edit: null,
      isMobile: false,
      ...over,
    },
    ctx,
  );
}

// jsdom does not know `scrollTo` on elements.
const scrollTo = vi.fn();

beforeEach(() => {
  HTMLElement.prototype.scrollTo = scrollTo;
});

afterEach(() => {
  scrollTo.mockClear();
  prefs.reset();
});

describe('time picker', () => {
  it('shows hours and minutes with the chosen time on desktop', () => {
    const view = render(TimePicker, { timePick: values(), isMobile: false });
    expect(view.getByText('Hour')).toBeInTheDocument();
    expect(view.getByText('Minute')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(view.queryByText('Quiet hours end')).toBeNull();
    const hours = view.getByRole('listbox', { name: 'Hour' });
    const mins = view.getByRole('listbox', { name: 'Minute' });
    expect(hours).toHaveAttribute('data-tcol', 'h');
    expect(mins).toHaveAttribute('data-tcol', 'm');
    const h = within(hours).getAllByRole('option');
    expect(h).toHaveLength(24);
    expect(h[0]).toHaveTextContent('00');
    expect(h[0]).toHaveAttribute('tabindex', '-1');
    expect(within(mins).getAllByRole('option')).toHaveLength(60);
    const selH = within(hours).getByRole('option', { selected: true });
    expect(selH).toHaveTextContent('07');
    expect(selH).toHaveClass('on');
    expect(selH).toHaveStyle({ fontWeight: '800' });
    expect(within(mins).getByRole('option', { selected: true })).toHaveTextContent('30');
    expect(h[1]).toHaveStyle({ fontWeight: '600' });
    expect(h[1]).not.toHaveClass('on');
  });

  it('chooses hour and minute', async () => {
    const ctx = context();
    const view = render(TimePicker, { timePick: values({}, ctx), isMobile: false });
    await fireEvent.click(within(view.getByRole('listbox', { name: 'Hour' })).getByRole('option', { name: '22' }));
    expect(ctx.set).toHaveBeenLastCalledWith('22:30');
    expect(ctx.show).not.toHaveBeenCalled();
    await fireEvent.click(within(view.getByRole('listbox', { name: 'Minute' })).getByRole('option', { name: '45' }));
    expect(ctx.set).toHaveBeenLastCalledWith('07:45');
    expect(ctx.show).toHaveBeenLastCalledWith(false);
  });

  it('shows hours with AM/PM in 12-hour format', () => {
    const view = render(TimePicker, { timePick: values({ h12: true, value: '22:00' }), isMobile: false });
    const hours = view.getByRole('listbox', { name: 'Hour' });
    expect(within(hours).getAllByRole('option')[0]).toHaveTextContent('12 AM');
    expect(within(hours).getByRole('option', { selected: true })).toHaveTextContent('10 PM');
  });

  it('shows title, close and "Done" on mobile', async () => {
    const ctx = context();
    const view = render(TimePicker, { timePick: values({ isMobile: true }, ctx), isMobile: true });
    expect(view.container.querySelector('.time-pick')).toHaveClass('mobile');
    expect(view.getByText('Quiet hours end')).toBeInTheDocument();
    expect(view.queryByText('Hour')).toBeNull();
    const hours = view.getByRole('listbox', { name: 'Hour' });
    expect(within(hours).getAllByRole('option')[0]).not.toHaveAttribute('tabindex');
    // The minute does not close on mobile.
    await fireEvent.click(within(view.getByRole('listbox', { name: 'Minute' })).getByRole('option', { name: '15' }));
    expect(ctx.set).toHaveBeenLastCalledWith('07:15');
    expect(ctx.show).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(ctx.show).toHaveBeenLastCalledWith(false);
    ctx.show.mockClear();
    await fireEvent.click(view.getByRole('button', { name: 'Done' }));
    expect(ctx.show).toHaveBeenCalledWith(false);
  });

  it('aligns the columns immediately on open, smoothly afterwards', async () => {
    const view = render(TimePicker, { timePick: values(), isMobile: false });
    expect(scrollTo).not.toHaveBeenCalled();
    await view.rerender({ timePick: values({ value: '08:30' }), isMobile: false });
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    scrollTo.mockClear();
    prefs.set({ animations: false });
    await view.rerender({ timePick: values({ value: '09:30' }), isMobile: false });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
