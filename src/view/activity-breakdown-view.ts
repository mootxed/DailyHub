import { setIcon } from "obsidian";
import type { ActivityBreakdownItem, DailyComputerActivity } from "../activity-models";
import { getIdentityColor, type IdentityKind } from "../identity-color";
import type { ActivityCategory } from "../models";
import { formatActivityDuration } from "../timeline-presentation";

export type ActivityBreakdownMode = "apps" | "sites" | "categories";

export interface ActivityBreakdownViewOptions {
  activity: DailyComputerActivity;
  mode: ActivityBreakdownMode;
  categories: ActivityCategory[];
  available: boolean;
  setMode: (mode: ActivityBreakdownMode) => void;
  openDetails?: (item: ActivityBreakdownItem, mode: ActivityBreakdownMode) => void;
}

const TOP_ITEM_COUNT = 5;

function displayItems(items: ActivityBreakdownItem[]): ActivityBreakdownItem[] {
  if (items.length <= TOP_ITEM_COUNT) return items;
  const visible = items.slice(0, TOP_ITEM_COUNT);
  const rest = items.slice(TOP_ITEM_COUNT);
  const seconds = rest.reduce((total, item) => total + item.seconds, 0);
  const denominator = items.reduce((total, item) => total + item.seconds, 0);
  return [...visible, {
    id: "other",
    label: "Other",
    seconds,
    percentage: denominator > 0 ? seconds / denominator : 0,
    children: rest
  }];
}

function itemColor(item: ActivityBreakdownItem, mode: ActivityBreakdownMode, categories: ActivityCategory[]): string {
  const kind: IdentityKind = mode === "apps" ? "app" : mode === "sites" ? "site" : "category";
  const explicitColorIndex = mode === "categories"
    ? categories.find((candidate) => candidate.id === item.id)?.colorIndex
    : undefined;
  return getIdentityColor(kind, item.id, explicitColorIndex);
}

function renderDomainBreakdown(container: HTMLElement, items: ActivityBreakdownItem[]): void {
  const nested = container.createDiv({ cls: "daily-hub-activity-domains" });
  for (const item of displayItems(items)) {
    const row = nested.createDiv({ cls: "daily-hub-activity-domain" });
    row.createEl("span", { text: item.label });
    row.createEl("strong", { text: formatActivityDuration(item.seconds) });
  }
}

export function renderActivityBreakdownView(
  container: HTMLElement,
  options: ActivityBreakdownViewOptions
): void {
  const section = container.createDiv({ cls: "daily-hub-activity-breakdown daily-hub-panel" });
  const heading = section.createDiv({ cls: "daily-hub-section-heading daily-hub-section-heading-with-tabs" });
  const copy = heading.createDiv();
  copy.createEl("div", { text: "Foreground activity", cls: "daily-hub-kicker" });
  copy.createEl("h2", { text: "Where your time went", cls: "daily-hub-section-title" });
  const tabs = heading.createDiv({
    cls: "daily-hub-segmented-control",
    attr: { role: "tablist", "aria-label": "Activity breakdown mode" }
  });
  for (const mode of ["apps", "sites", "categories"] as const) {
    const selected = options.mode === mode;
    const button = tabs.createEl("button", {
      text: mode === "apps" ? "Apps" : mode === "sites" ? "Sites" : "Categories",
      cls: selected ? "is-selected" : "",
      attr: { role: "tab", "aria-selected": String(selected), type: "button" }
    });
    button.addEventListener("click", () => options.setMode(mode));
  }

  if (!options.available) {
    section.createEl("p", { text: "Computer activity unavailable.", cls: "daily-hub-muted", attr: { role: "status" } });
    return;
  }
  if (options.activity.activeComputerSeconds === 0) {
    section.createEl("p", {
      text: "No active computer time recorded yet today.",
      cls: "daily-hub-muted",
      attr: { role: "status" }
    });
    return;
  }

  const total = section.createDiv({ cls: "daily-hub-activity-total" });
  total.createEl("strong", {
    text: formatActivityDuration(options.mode === "sites"
      ? options.activity.sites.reduce((sum, item) => sum + item.seconds, 0)
      : options.activity.activeComputerSeconds)
  });
  total.createEl("span", { text: options.mode === "sites" ? "browser time" : "active computer time" });

  const source = options.mode === "apps"
    ? options.activity.applications
    : options.mode === "sites"
      ? options.activity.sites
      : options.activity.categories;
  if (source.length === 0) {
    section.createEl("p", { text: "No foreground browser domains recorded for this day.", cls: "daily-hub-muted" });
    return;
  }

  const list = section.createDiv({ cls: "daily-hub-activity-breakdown-list" });
  const maximum = Math.max(source[0]?.seconds ?? 0, 1);
  const renderList = (items: ActivityBreakdownItem[]): void => {
    list.empty();
    for (const item of items) {
      const canOpen = options.openDetails !== undefined;
      const row = list.createDiv({
        cls: `daily-hub-activity-breakdown-item${canOpen ? " is-clickable" : ""}`,
        attr: canOpen ? {
          role: "button",
          tabindex: "0",
          "aria-label": `Open details for ${item.label}`
        } : {}
      });
      row.style.setProperty("--dh-activity-color", itemColor(item, options.mode, options.categories));
      const label = row.createDiv({ cls: "daily-hub-activity-breakdown-heading" });
      const name = label.createDiv({ cls: "daily-hub-activity-breakdown-name" });
      name.createEl("span", { cls: "daily-hub-activity-swatch", attr: { "aria-hidden": "true" } });
      name.createEl("strong", { text: item.label });
      const meta = label.createDiv({ cls: "daily-hub-activity-breakdown-meta" });
      meta.createEl("span", {
        text: `${formatActivityDuration(item.seconds)} · ${Math.round(item.percentage * 100)}%`
      });
      if (canOpen) {
        const chevron = meta.createSpan({ cls: "daily-hub-activity-row-chevron", attr: { "aria-hidden": "true" } });
        setIcon(chevron, "chevron-right");
      }
      const track = row.createDiv({ cls: "daily-hub-activity-breakdown-track" });
      track.createDiv({
        cls: "daily-hub-activity-breakdown-bar",
        attr: { style: `width: ${(item.seconds / maximum) * 100}%` }
      });
      if (options.mode === "apps" && item.domainBreakdown !== undefined) {
        const toggle = row.createEl("button", {
          cls: "daily-hub-activity-drilldown-button",
          attr: { type: "button", "aria-expanded": "false" }
        });
        const icon = toggle.createSpan({ attr: { "aria-hidden": "true" } });
        setIcon(icon, "chevron-right");
        const count = item.domainBreakdown.length;
        toggle.createSpan({ text: `${count} ${count === 1 ? "domain" : "domains"}` });
        let expanded = false;
        let detail: HTMLElement | undefined;
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          expanded = !expanded;
          toggle.setAttribute("aria-expanded", String(expanded));
          setIcon(icon, expanded ? "chevron-down" : "chevron-right");
          if (expanded) {
            detail ??= row.createDiv();
            detail.empty();
            renderDomainBreakdown(detail, item.domainBreakdown ?? []);
          } else detail?.empty();
        });
      }
      if (canOpen) {
        const open = (): void => options.openDetails?.(item, options.mode);
        row.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest(".daily-hub-activity-drilldown-button") === null) open();
        });
        row.addEventListener("keydown", (event) => {
          if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          open();
        });
      }
    }
  };
  renderList(displayItems(source));
  if (source.length > TOP_ITEM_COUNT) {
    const viewAll = section.createEl("button", {
      text: "View all activity →",
      cls: "daily-hub-activity-view-all",
      attr: { type: "button", "aria-expanded": "false" }
    });
    let expanded = false;
    viewAll.addEventListener("click", () => {
      expanded = !expanded;
      viewAll.setText(expanded ? "Show top activity ↑" : "View all activity →");
      viewAll.setAttribute("aria-expanded", String(expanded));
      renderList(expanded ? source : displayItems(source));
    });
  }
}
