export type Role = "owner" | "manager" | "trainer" | "mechanic";

export interface Profile {
  discord_id: string;
  display_name: string;
  sales_channel_id: string | null;
  commission_rate: number;
  hours_worked_this_week: number;
  status: "online" | "offline" | "on_break";
  created_at: string;
}

export interface UserRole {
  discord_id: string;
  role: Role;
}

export interface OrderItem {
  label: string;
  price: number;
  cost: number;
  category: string;
}

export interface Order {
  id: string;
  order_number: string;
  mechanic_id: string;
  status: "draft" | "submitted" | "approved" | "paid" | "rejected" | "archived";
  items: OrderItem[];
  parts_cost: number;
  total: number;
  labour: number;
  notes: string;
  rejected_reason: string | null;
  discord_message_id: string | null;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  completed_at: string | null;
}

export interface Timeclock {
  id: string;
  mechanic_id: string;
  clock_in_time: string;
  clock_out_time: string | null;
  duration_minutes: number;
  approved_by: string | null;
  status: "pending" | "approved" | "rejected";
  notes: string | null;
  created_at: string;
}

export interface Payout {
  id: string;
  mechanic_id: string;
  week_start: string;
  amount: number;
  order_count: number;
  hours_worked: number;
  invoice_count: number;
  paid_at: string | null;
  paid_by: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  posted_by: string;
  title: string;
  body: string;
  discord_message_id: string;
  created_at: string;
  expires_at: string | null;
}

export interface GuildConfig {
  guild_id: string;
  orders_channel_id: string | null;
  jobs_channel_id: string | null;
  log_channel_id: string | null;
  archive_channel_id: string | null;
}

export interface AppSetting {
  key: string;
  value: string;
}
