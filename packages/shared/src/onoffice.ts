/** Authenticated with an API user's token + secret; neither is ever returned to the browser. */
export interface OnOfficeStatus {
  configured: boolean;
  source: "settings" | "env" | null;
  apiUrl: string;
  /** Whether unattended automation runs may create CRM records; never modify/delete/send. */
  automationCreates: boolean;
  /** Whether chat sessions may modify, delete or send; reads and creates are always available in chat. */
  writeAccess: boolean;
}

/** Either field may be omitted to keep the saved one. */
export interface OnOfficeConfigInput {
  token?: string;
  secret?: string;
}
