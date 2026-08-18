import {
  buildActivityChartSeries,
  filterActivityChartSeries,
  formatChartDuration,
  getMaximumChartSeconds,
  getNiceTimeScale
} from "../activity-chart";
import { formatDuration } from "../dashboard";
import type { DailyGoal, GoalProgress } from "../models";

export interface ActivityChartDayView {
  key: string;
  date: Date;
  future: boolean;
  progress: GoalProgress[] | undefined;
}

export interface ActivityChartViewOptions {
  goals: DailyGoal[];
  days: ActivityChartDayView[];
  hiddenGoalIds: Set<string>;
  selectDate: (dateKey: string) => void;
}

export function renderActivityChartView(container: HTMLElement, options: ActivityChartViewOptions): void {
  const allSeries = buildActivityChartSeries(options.goals, options.days.map((day) => ({
    dateKey: day.key,
    future: day.future,
    progress: day.progress
  })));
  const section = container.createDiv({ cls: "daily-hub-line-chart-card daily-hub-panel" });
  const heading = section.createDiv({ cls: "daily-hub-section-heading" });
  heading.createEl("div", { text: "Activity", cls: "daily-hub-kicker" });
  heading.createEl("h2", { text: "Activity over time", cls: "daily-hub-section-title" });

  const legend = section.createDiv({
    cls: "daily-hub-chart-legend",
    attr: { role: "group", "aria-label": "Toggle goal activity series" }
  });
  const chart = section.createDiv({ cls: "daily-hub-chart-content" });

  const render = (): void => {
    legend.empty();
    chart.empty();
    for (const item of allSeries) {
      const visible = !options.hiddenGoalIds.has(item.goalId);
      const button = legend.createEl("button", {
        cls: `daily-hub-chart-legend-item${visible ? "" : " is-hidden"}`,
        attr: { type: "button", "aria-pressed": String(visible), "aria-label": `${visible ? "Hide" : "Show"} ${item.goalName}` }
      });
      const swatch = button.createSpan({ cls: "daily-hub-chart-swatch", attr: { "aria-hidden": "true" } });
      swatch.style.setProperty("--dh-goal-color", item.color);
      button.createSpan({ text: item.goalName });
      button.addEventListener("click", () => {
        if (visible) options.hiddenGoalIds.add(item.goalId);
        else options.hiddenGoalIds.delete(item.goalId);
        render();
      });
    }

    const series = filterActivityChartSeries(allSeries, options.hiddenGoalIds);
    if (series.length === 0) {
      const empty = chart.createDiv({ cls: "daily-hub-chart-empty-state" });
      empty.createEl("p", { text: "All goal series are hidden.", cls: "daily-hub-muted" });
      const showAll = empty.createEl("button", { text: "Show all", attr: { type: "button" } });
      showAll.addEventListener("click", () => {
        options.hiddenGoalIds.clear();
        render();
      });
      return;
    }
    if (!series.some((item) => item.points.some((point) => point.seconds !== null))) {
      chart.createEl("p", { text: "No tracked activity for this period.", cls: "daily-hub-chart-empty daily-hub-muted" });
      return;
    }
    if (getMaximumChartSeconds(series) === 0) {
      const empty = chart.createDiv({ cls: "daily-hub-chart-empty-state is-zero-activity" });
      empty.createEl("strong", { text: "No activity recorded yet." });
      empty.createEl("span", {
        text: "Your chart will appear after tracked time is recorded.",
        cls: "daily-hub-muted"
      });
      return;
    }

    const width = 800;
    const height = 250;
    const left = 62;
    const right = 18;
    const top = 18;
    const bottom = 42;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const scale = getNiceTimeScale(getMaximumChartSeconds(series));
    const scroll = chart.createDiv({ cls: "daily-hub-line-chart-scroll" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "daily-hub-line-chart");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Goal activity over the selected week");
    scroll.appendChild(svg);

    const createSvg = <K extends keyof SVGElementTagNameMap>(
      tag: K,
      attributes: Record<string, string>
    ): SVGElementTagNameMap[K] => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      svg.appendChild(element);
      return element;
    };
    const xPosition = (index: number): number => left + (
      options.days.length <= 1 ? plotWidth / 2 : (index / (options.days.length - 1)) * plotWidth
    );
    const yPosition = (seconds: number): number => top + plotHeight
      - (seconds / scale.maximumSeconds) * plotHeight;

    const yTitle = createSvg("text", {
      x: String(left), y: "11", class: "daily-hub-chart-axis-title", "text-anchor": "start"
    });
    yTitle.textContent = "TIME";
    for (const tick of scale.ticks) {
      const y = yPosition(tick);
      createSvg("line", {
        x1: String(left), y1: String(y), x2: String(width - right), y2: String(y),
        class: "daily-hub-chart-grid-line"
      });
      const label = createSvg("text", {
        x: String(left - 10), y: String(y + 4), class: "daily-hub-chart-axis-label", "text-anchor": "end"
      });
      label.textContent = formatChartDuration(tick);
    }

    const dayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
    const fullDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });
    options.days.forEach((day, index) => {
      const x = xPosition(index);
      createSvg("line", {
        x1: String(x), y1: String(top), x2: String(x), y2: String(top + plotHeight),
        class: "daily-hub-chart-grid-line is-vertical"
      });
      const label = createSvg("text", {
        x: String(x), y: String(height - 14),
        class: `daily-hub-chart-axis-label${day.progress === undefined ? " is-missing" : ""}`,
        "text-anchor": "middle"
      });
      label.textContent = dayFormatter.format(day.date);
    });

    for (const item of series) {
      let continuing = false;
      const pathParts: string[] = [];
      item.points.forEach((point, index) => {
        if (point.seconds === null) {
          continuing = false;
          return;
        }
        pathParts.push(`${continuing ? "L" : "M"} ${xPosition(index)} ${yPosition(point.seconds)}`);
        continuing = true;
      });
      const path = createSvg("path", { d: pathParts.join(" "), class: "daily-hub-chart-series", fill: "none" });
      path.style.setProperty("--dh-goal-color", item.color);

      item.points.forEach((point, index) => {
        if (point.seconds === null) return;
        const day = options.days[index];
        if (day === undefined) return;
        const duration = formatDuration(point.seconds);
        const dateLabel = fullDateFormatter.format(day.date);
        const pointLabel = `${item.goalName}, ${dateLabel}, ${duration}. Open date.`;
        const circle = createSvg("circle", {
          cx: String(xPosition(index)), cy: String(yPosition(point.seconds)), r: "4",
          class: "daily-hub-chart-point", tabindex: "0", role: "button", "aria-label": pointLabel
        });
        circle.style.setProperty("--dh-goal-color", item.color);
        const openDate = (): void => options.selectDate(point.dateKey);
        circle.addEventListener("click", openDate);
        circle.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDate();
          }
        });
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = `${item.goalName}\n${dateLabel}\n${duration}`;
        circle.appendChild(title);
      });
    }
  };
  render();
}
