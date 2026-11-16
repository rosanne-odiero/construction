"use client";

import * as React from "react";
import { CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { nairobiDate } from "@pm-buddy/domain";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  calendarSpan,
  dateToIso,
  displayDate,
  isoToDate,
  openingDate,
  outOfRange,
  parseDateText,
} from "@/lib/date-input";

/**
 * Date fields: typed as DD/MM/YYYY (brief §9) or picked from a calendar. `DateInput` replaces
 * `<input type="date">` (ISO in and out); `DateTextInput` is for forms that parse the typed text
 * themselves with `parseCalendarInput`. Bounds (`min`, `max`) are ISO dates.
 */

const PLACEHOLDER = "DD/MM/YYYY";

/** Weekday header keys by `Date.getDay()`; weeks start on Monday. */
const WEEKDAY_KEYS = [
  "weekdays.7",
  "weekdays.1",
  "weekdays.2",
  "weekdays.3",
  "weekdays.4",
  "weekdays.5",
  "weekdays.6",
] as const;

type Bounds = { min?: string; max?: string };

/** Our own handle on the input, also exposed through the caller's `ref`. */
function useInputRef(ref: React.Ref<HTMLInputElement> | undefined) {
  const input = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(ref, () => input.current!, []);
  return input;
}

function CalendarPanel({
  selected,
  min,
  max,
  onPick,
}: Bounds & { selected: string | null; onPick: (iso: string) => void }) {
  const t = useTranslations("datePicker");
  const locale = useLocale();
  const today = nairobiDate();
  const span = calendarSpan(today, selected, min, max);
  const formats = React.useMemo(() => {
    // Calendar dates are local midnights: formatting them in the browser's zone keeps the day.
    const intl = locale === "sw" ? "sw-KE" : "en-GB";
    return {
      caption: new Intl.DateTimeFormat(intl, { month: "long", year: "numeric" }),
      month: new Intl.DateTimeFormat(intl, { month: "long" }),
      weekday: new Intl.DateTimeFormat(intl, { weekday: "long" }),
      day: new Intl.DateTimeFormat(intl, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    };
  }, [locale]);

  return (
    <>
      <Calendar
        mode="single"
        required
        autoFocus
        captionLayout="dropdown"
        weekStartsOn={1}
        lang={locale}
        className="[--cell-size:--spacing(9)]"
        today={isoToDate(today)}
        selected={selected ? isoToDate(selected) : undefined}
        defaultMonth={isoToDate(openingDate(today, selected, min, max))}
        startMonth={isoToDate(span.start)}
        endMonth={isoToDate(span.end)}
        disabled={[
          ...(min ? [{ before: isoToDate(min) }] : []),
          ...(max ? [{ after: isoToDate(max) }] : []),
        ]}
        onSelect={(date) => onPick(dateToIso(date))}
        formatters={{
          formatCaption: (date) => formats.caption.format(date),
          formatMonthDropdown: (date) => formats.month.format(date),
          formatWeekdayName: (date) => t(WEEKDAY_KEYS[date.getDay()]!),
        }}
        labels={{
          labelDayButton: (date, modifiers) =>
            [
              formats.day.format(date),
              modifiers.today ? t("today") : null,
              modifiers.selected ? t("selected") : null,
            ]
              .filter(Boolean)
              .join(", "),
          labelGrid: (date) => formats.caption.format(date),
          labelWeekday: (date) => formats.weekday.format(date),
          labelPrevious: () => t("previousMonth"),
          labelNext: () => t("nextMonth"),
          labelMonthDropdown: () => t("month"),
          labelYearDropdown: () => t("year"),
        }}
      />
      <div className="border-t p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={outOfRange(today, min, max) !== null}
          onClick={() => onPick(today)}
        >
          {t("today")}
        </Button>
      </div>
    </>
  );
}

/** The field frame shared by both inputs: the input, a calendar button and the calendar. */
function DatePicker({
  className,
  disabled,
  min,
  max,
  current,
  onPick,
  children,
}: Bounds & {
  className?: string;
  disabled?: boolean;
  /** The field's date (ISO), read when the calendar opens. */
  current: () => string | null;
  onPick: (iso: string) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("datePicker");
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const toggle = (next: boolean) => {
    if (next) setSelected(current());
    setOpen(next);
  };

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverAnchor asChild>
        <InputGroup
          className={className}
          data-disabled={disabled ? "true" : undefined}
          onKeyDown={(event) => {
            // Alt+↓ opens the calendar from the keyboard, as in a native date field.
            if (event.altKey && event.key === "ArrowDown" && !disabled) {
              event.preventDefault();
              toggle(true);
            }
          }}
        >
          {children}
          <InputGroupAddon align="inline-end">
            <PopoverTrigger asChild>
              <InputGroupButton size="icon-xs" aria-label={t("open")} disabled={disabled}>
                <CalendarDays aria-hidden />
              </InputGroupButton>
            </PopoverTrigger>
          </InputGroupAddon>
        </InputGroup>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        aria-label={t("calendar")}
        className="w-auto gap-0 p-0"
        // The calendar moves focus to the selected day (or today) itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <CalendarPanel
          selected={selected}
          min={min}
          max={max}
          onPick={(iso) => {
            onPick(iso);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

type DateInputProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"
> &
  Bounds & {
    /** ISO date, or "" for none. */
    value?: string;
    /** ISO date, or "" for none. */
    defaultValue?: string;
    /** The new ISO date, or "" while the field is empty or not yet a valid date. */
    onValueChange?: (value: string) => void;
  };

/**
 * A date field submitted like `<input type="date">`: `name` carries the ISO date (empty while the
 * text is not a valid date). The browser's form validation checks `required`, the DD/MM/YYYY
 * format and `min`/`max`.
 */
export function DateInput({
  value,
  defaultValue = "",
  onValueChange,
  min,
  max,
  name,
  form,
  required,
  disabled,
  readOnly,
  className,
  placeholder = PLACEHOLDER,
  onBlur,
  ref,
  ...props
}: DateInputProps) {
  const t = useTranslations("datePicker");
  const input = useInputRef(ref);
  const controlled = value !== undefined;
  const [text, setText] = React.useState(() => displayDate(controlled ? value : defaultValue));
  const parsed = parseDateText(text);
  const iso = parsed ?? "";
  // A new value from the parent replaces the text, unless the text already says that date.
  const [seen, setSeen] = React.useState(value);
  if (controlled && value !== seen) {
    setSeen(value);
    if (value !== iso) setText(displayDate(value));
  }

  const lower = min || undefined;
  const upper = max || undefined;
  const range = iso ? outOfRange(iso, lower, upper) : null;
  const problem =
    parsed === undefined
      ? t("invalid")
      : range === "early"
        ? t("tooEarly", { date: displayDate(lower) })
        : range === "late"
          ? t("tooLate", { date: displayDate(upper) })
          : "";
  React.useEffect(() => input.current?.setCustomValidity(problem), [input, problem]);

  // A form reset restores the default date, as it does for a native date field.
  React.useEffect(() => {
    const owner = input.current?.form;
    if (controlled || !owner) return;
    const reset = () => setText(displayDate(defaultValue));
    owner.addEventListener("reset", reset);
    return () => owner.removeEventListener("reset", reset);
  }, [input, controlled, defaultValue]);

  const change = (next: string) => {
    setText(next);
    const nextIso = parseDateText(next) ?? "";
    if (nextIso !== iso) onValueChange?.(nextIso);
  };

  return (
    <>
      <DatePicker
        className={className}
        disabled={disabled || readOnly}
        min={lower}
        max={upper}
        current={() => iso || null}
        onPick={(next) => change(displayDate(next))}
      >
        <InputGroupInput
          {...props}
          ref={input}
          className="h-full"
          form={form}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          placeholder={placeholder}
          autoComplete="off"
          value={text}
          onChange={(event) => change(event.target.value)}
          onBlur={(event) => {
            if (parsed) setText(displayDate(parsed));
            onBlur?.(event);
          }}
        />
      </DatePicker>
      {name ? (
        <input type="hidden" name={name} value={iso} form={form} disabled={disabled} />
      ) : null}
    </>
  );
}

/**
 * A DD/MM/YYYY text field with a calendar, for forms that read the typed text themselves
 * (`parseCalendarInput`). Picking a date writes it into the input as if typed, so controlled
 * (`value`/`onChange`) and uncontrolled (`defaultValue`) inputs both work.
 */
export function DateTextInput({
  min,
  max,
  className,
  disabled,
  readOnly,
  placeholder = PLACEHOLDER,
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "min" | "max"> & Bounds) {
  const input = useInputRef(ref);

  return (
    <DatePicker
      className={className}
      disabled={disabled || readOnly}
      min={min || undefined}
      max={max || undefined}
      current={() => parseDateText(input.current?.value ?? "") ?? null}
      onPick={(iso) => {
        const node = input.current;
        if (!node) return;
        // The native setter bypasses React's value tracking, so the events reach onChange.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          node,
          displayDate(iso),
        );
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }}
    >
      <InputGroupInput
        {...props}
        ref={input}
        className="h-full"
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        autoComplete="off"
      />
    </DatePicker>
  );
}
