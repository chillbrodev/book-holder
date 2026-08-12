/** What the coach decided she should do next. */
export interface CoachRecommendation {
  id: string;
  /** One or two sentences, in her language. The thing she actually reads. */
  note: string;
  /** `drill` runs the named speeches; `scene` runs the whole scene. "Nothing
   * worth saying" is expressed by there being no recommendation at all, rather
   * than by an action of 'none' reaching the client. */
  action: "drill" | "scene";
  act: string;
  scene: string;
  /** The speeches to drill. Empty for a `scene` action. */
  blockIds: string[];
}
