/** What the coach decided she should do next. */
export interface CoachRecommendation {
  id: string;
  /** One or two sentences, in her language. The thing she actually reads. */
  note: string;
  /** Why this and not something else, in her marks — "Two of its nine beats
   * are dry and four more are close." The evidence under the note, shown
   * separately from it. Empty when the agent gave none, or when the row predates
   * migration 012; the screen omits the line rather than showing a blank. */
  rationale: string;
  /** `drill` runs the named speeches; `scene` runs the whole scene. "Nothing
   * worth saying" is expressed by there being no recommendation at all, rather
   * than by an action of 'none' reaching the client. */
  action: "drill" | "scene";
  act: string;
  scene: string;
  /** The speeches to drill. Empty for a `scene` action. */
  blockIds: string[];
}
