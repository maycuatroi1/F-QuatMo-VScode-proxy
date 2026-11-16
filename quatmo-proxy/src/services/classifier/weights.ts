/** Train-only calibration: NOMINAL weights in [0.20, 0.65]; CALIBRATED weights in [0.20, 0.90].
 * Frozen model SHA-256: 2d68fea4de40f6303ea56a7b8341bc67971111f17b3e297473954adf48508b4a
 */

export const NOMINAL_INSTRUMENTAL_WEIGHTS: Record<string, number> = {
  i1: 0.45,
  i2: 0.65,
  i3: 0.65,
  i4: 0.65,
  i5: 0.60,
  i6: 0.65,
  i7: 0.65,
  i8: 0.45,
  r1: 0.65,
  r2: 0.65,
  r3: 0.55,
  r4: 0.55,
  r5: 0.65,
  r6: 0.65,
  t1: 0.65,
  t2: 0.65,
  t3: 0.65,
  t4: 0.25,
  t5: 0.65,
  c1: 0.65,
  c2: 0.65,
  c3: 0.65,
  c4: 0.20,
  c5: 0.55,
};

export const CALIBRATED_INSTRUMENTAL_WEIGHTS: Record<string, number> = {
  c1: 0.58,
  c2: 0.57,
  c3: 0.43,
  c4: 0.48,
  c5: 0.2,
  i1: 0.35,
  i2: 0.45,
  i3: 0.65,
  i4: 0.7,
  i5: 0.43,
  i6: 0.55,
  i7: 0.75,
  i8: 0.45,
  r1: 0.4,
  r2: 0.6,
  r3: 0.45,
  r4: 0.37,
  r5: 0.75,
  r6: 0.45,
  t1: 0.55,
  t2: 0.5,
  t3: 0.65,
  t4: 0.52,
  t5: 0.65,
};

// Compatibility alias for existing consumers.
export const EMPIRICAL_DISTRIBUTION_NOISE_INSTRUMENTAL_WEIGHTS = CALIBRATED_INSTRUMENTAL_WEIGHTS;

// Compatibility alias for existing consumers.
export const WOE_INSTRUMENTAL_WEIGHTS = CALIBRATED_INSTRUMENTAL_WEIGHTS;

export const INSTRUMENTAL_WEIGHTS: Record<string, number> =
  process.env.IEM_WEIGHT_MODE === "nominal"
    ? NOMINAL_INSTRUMENTAL_WEIGHTS
    : CALIBRATED_INSTRUMENTAL_WEIGHTS;

export const NOMINAL_EXECUTIVE_WEIGHTS: Record<string, number> = {
  e1: 0.65,
  e2: 0.65,
  e3: 0.65,
  e4: 0.65,
  e5: 0.65,
  e6: 0.40,
  r7: 0.50,
  r8: 0.40,
  t6: 0.65,
  t7: 0.65,
  t8: 0.55,
  t9: 0.50,
  t10: 0.65,
  c6: 0.65,
  c7: 0.65,
  c8: 0.65,
  c9: 0.65,
  c10: 0.55,
};

export const CALIBRATED_EXECUTIVE_WEIGHTS: Record<string, number> = {
  c10: 0.65,
  c6: 0.89,
  c7: 0.9,
  c8: 0.84,
  c9: 0.8,
  e1: 0.89,
  e2: 0.83,
  e3: 0.79,
  e4: 0.65,
  e5: 0.65,
  e6: 0.55,
  r7: 0.8,
  r8: 0.84,
  t10: 0.85,
  t6: 0.85,
  t7: 0.8,
  t8: 0.6,
  t9: 0.55,
};

// Compatibility alias for existing consumers.
export const EMPIRICAL_DISTRIBUTION_NOISE_EXECUTIVE_WEIGHTS = CALIBRATED_EXECUTIVE_WEIGHTS;

// Compatibility alias for existing consumers.
export const WOE_EXECUTIVE_WEIGHTS = CALIBRATED_EXECUTIVE_WEIGHTS;

export const EXECUTIVE_WEIGHTS: Record<string, number> =
  process.env.IEM_WEIGHT_MODE === "nominal"
    ? NOMINAL_EXECUTIVE_WEIGHTS
    : CALIBRATED_EXECUTIVE_WEIGHTS;

// Inclusive decision boundaries; shared by Turn and Session.
export const IEM_DECISION_GATE = Object.freeze({
  M_I: 0.60,
  M_E: 0.30,
});

export const IEM_WINDOW_SIZE = 5;

// Reference scales for confidence, independent of classification boundaries.
export const IEM_HIGH_THRESHOLD = 0.55;
export const IEM_MID_THRESHOLD = 0.45;
export const IEM_MARGIN_THRESHOLD = 0.15;
export const IEM_DOMINANT_SEPARATION = 0.20;

export const FEATURE_DESCRIPTIONS: Record<string, { name: string; category: string; description: string }> = {
  i1: { name: "Inquire No Context", category: "Instrumental Prompt", description: "Basic, isolated question without code or problem context" },
  i2: { name: "Integrate With Context", category: "Instrumental Prompt", description: "Question integrating student code, problem details, or error trace" },
  i3: { name: "Conceptual Question", category: "Instrumental Prompt", description: "Questions about algorithms, mechanisms, or theoretical concepts" },
  i4: { name: "Problem Understanding", category: "Instrumental Prompt", description: "Questions clarifying requirements, constraints, or problem scope" },
  i5: { name: "Example Request", category: "Instrumental Prompt", description: "Request for an illustrative example or minimal demonstration" },
  i6: { name: "Error Interpretation", category: "Instrumental Prompt", description: "Asks why an error occurs or root-cause diagnosis without demanding bug fix" },
  i7: { name: "Verification Request", category: "Instrumental Prompt", description: "Asks AI to verify/validate reasoning, idea, or partial approach" },
  i8: { name: "Soft Implementation Question", category: "Instrumental Prompt", description: "Soft inquiries about syntax, library API usage, or parameter specifications" },

  e1: { name: "Code Generation Request", category: "Executive Prompt", description: "Direct demand for AI to generate complete code or implementation" },
  e2: { name: "Delegate Request", category: "Executive Prompt", description: "Delegates coding task entirely to AI ('write this for me', 'finish assignment')" },
  e3: { name: "Assignment Pasted", category: "Executive Prompt", description: "Raw assignment or exam prompt dumped into chat demanding solution" },
  e4: { name: "Code Pasted No Question", category: "Executive Prompt", description: "Code pasted without analytical question, expecting AI to complete/fix" },
  e5: { name: "Direct Correction Request", category: "Executive Prompt", description: "Demands AI directly fix/rewrite broken code to pass" },
  e6: { name: "Results Pasted", category: "Executive Prompt", description: "Pastes test output or error logs passively expecting AI to resolve" },

  r1: { name: "Tutor Role", category: "Instrumental Response", description: "AI adopts pedagogical persona encouraging student reasoning" },
  r2: { name: "Conceptual Explanation", category: "Instrumental Response", description: "AI explains logic or concept without replacement code" },
  r3: { name: "Code Explanation", category: "Instrumental Response", description: "AI walks through existing code mechanics or algorithms" },
  r4: { name: "Example Only", category: "Instrumental Response", description: "AI provides generic, isolated illustrative example" },
  r5: { name: "Evaluator Feedback Only", category: "Instrumental Response", description: "AI gives review comments, critique, or code assessment without solution" },
  r6: { name: "Stepwise Hint", category: "Instrumental Response", description: "AI gives step-by-step guidance, pseudocode, or algorithmic hints" },

  r7: { name: "Executor Role", category: "Executive Response", description: "AI acts as executor, implementing solution directly" },
  r8: { name: "Exact Solution Code", category: "Executive Response", description: "AI delivers complete, runnable solution code" },

  t1: { name: "Sustained Inquiry Pattern", category: "Trajectory", description: "Consecutive turns show conceptual inquiry without escalating to asking code" },
  t2: { name: "Self-Correction After Hint", category: "Trajectory", description: "Student edits/fixes code in current turn after AI provided hints in previous turn" },
  t3: { name: "Increasing Own Reasoning", category: "Trajectory", description: "Subsequent turns show student reasoning becoming more specific and structured" },
  t4: { name: "Verification Loop", category: "Trajectory", description: "Student repeatedly verifies correctness or tests ideas before accepting solution" },
  t5: { name: "Rejection of Full Solution", category: "Trajectory", description: "Student declines/ignores offered full solution to solve independently" },
  t6: { name: "Repeated Copy-Paste Pattern", category: "Trajectory", description: "Consecutive turns show student repeatedly pasting AI code without writing intermediate code" },
  t7: { name: "Escalation to Full Solution", category: "Trajectory", description: "Starts with small question but escalates into demanding complete code" },
  t8: { name: "Abandon After Code Received", category: "Trajectory", description: "Abruptly ends interaction immediately after receiving working code" },
  t9: { name: "Minimal Effort Between Turns", category: "Trajectory", description: "Time between turns is too short to have read, understood, or tested code" },
  t10: { name: "Recurring Delegate Across Session", category: "Trajectory", description: "Delegation phrases recur across multiple turns in sliding window" },

  c1: { name: "High Student Modification Ratio", category: "Code-Diff", description: "High ratio of lines modified/written by student vs AI suggestions" },
  c2: { name: "Incremental Small Step Changes", category: "Code-Diff", description: "Code evolves in small, stepwise increments across turns" },
  c3: { name: "Structural Divergence From AI", category: "Code-Diff", description: "Final code structure differs from AI suggestions — student restructured" },
  c4: { name: "Test-Driven Iteration", category: "Code-Diff", description: "Code edits are accompanied by student running tests between turns" },
  c5: { name: "Own Algorithm Signature", category: "Code-Diff", description: "Final code implements an algorithm style never suggested by AI" },
  c6: { name: "Exact Copy Ratio", category: "Code-Diff", description: "Code lines are virtually identical to AI output" },
  c7: { name: "Single Large Jump", category: "Code-Diff", description: "Code jumps from empty/minimal to almost complete in a single turn" },
  c8: { name: "Structural Identity With AI", category: "Code-Diff", description: "Final code structure is identical to AI output without reorganization" },
  c9: { name: "No Intermediate Edits", category: "Code-Diff", description: "No edits occurred between receiving code from AI and submitting" },
  c10: { name: "Zero Own Test Activity", category: "Code-Diff", description: "No evidence of student testing/running code before asking next step" },
};

