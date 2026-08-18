import type { ActivityCategory } from "./models";

export interface ComputerActivitySegment {
  startMs: number;
  endMs: number;
  application: string;
  displayApplication: string;
  windowTitle?: string;
  browser?: string;
  domain?: string;
  categoryId?: string;
}

export interface ActivityBreakdownItem {
  id: string;
  label: string;
  seconds: number;
  percentage: number;
  domainBreakdown?: ActivityBreakdownItem[];
}

export interface DailyComputerActivity {
  dateKey: string;
  available: boolean;
  activeComputerSeconds: number;
  browserForegroundSeconds: number;
  segments: ComputerActivitySegment[];
  applications: ActivityBreakdownItem[];
  sites: ActivityBreakdownItem[];
  categories: ActivityBreakdownItem[];
}

export interface ComputerActivityRange {
  totalSeconds: number;
  averageSeconds?: number;
  activeDays: number;
  availableDays: number;
  days: DailyComputerActivity[];
  applications: ActivityBreakdownItem[];
  categories: ActivityBreakdownItem[];
  topApplication?: ActivityBreakdownItem;
  topCategory?: ActivityBreakdownItem;
}

export interface ActivityCategoryAssignment {
  category: ActivityCategory | undefined;
  categoryId: string | undefined;
  label: string;
}
