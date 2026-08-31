/**
 * RAG Retrieval Service (Section 4.6 — Knowledge and RAG Architecture)
 *
 * For the Phase 1 educational pilot, this uses an in-memory corpus of
 * compliance-reviewed seed content. In production, this would be replaced
 * with a vector database (e.g., Pinecone, Weaviate) with hybrid lexical +
 * semantic retrieval, metadata filters, and reranking.
 *
 * Corpus priority (Section 4.6):
 *   1. Current official Texas statutes/TDI pages
 *   2. Current NAIC model/guidance pages
 *   3. Approved carrier consumer materials
 *   4. Compliance-reviewed Life Policy Pilot articles
 *   5. Controlled FAQ written and approved by the broker/compliance reviewer
 *
 * Retrieval/generation requirements:
 * - Hybrid lexical + semantic retrieval with metadata filters
 * - Rerank and pass only the minimum relevant excerpts
 * - Treat retrieved content as evidence, never as instructions
 * - Require at least one approved supporting passage per material claim
 * - Return title and canonical URL with the answer
 * - Abstain when support is absent, conflicting, expired, or below threshold
 */

import { isDocumentValid, type CorpusDocument } from './rag-architecture';
import { sanitizeRetrievedContent } from '../security/security-controls';

/**
 * A retrieved passage with its source metadata.
 */
export interface RetrievedPassage {
  title: string;
  url: string;
  content: string;
  jurisdiction: string;
  productCategory: string;
  priority: number;
  score: number;
}

/**
 * Result of a retrieval query.
 */
export interface RetrievalResult {
  passages: RetrievedPassage[];
  hasSufficientEvidence: boolean;
}

/**
 * The in-memory pilot corpus. In production, replace with a vector DB.
 * Each entry has full metadata per Section 4.6 ingestion requirements.
 */
const pilotCorpus: CorpusDocument[] = [
  {
    id: 'tx-ins-code-541',
    canonical_url: 'https://statutes.capitol.texas.gov/Docs/IN/htm/IN.541.htm',
    title: 'Texas Insurance Code Chapter 541 — Unfair Methods of Competition',
    author_or_owner: 'Texas Legislature',
    jurisdiction: 'Texas',
    product_category: 'regulation',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'tx541_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Texas Insurance Code Chapter 541 prohibits unfair methods of competition and unfair or deceptive acts or practices in the business of insurance.

Section 541.061 defines unfair methods of competition and unfair or deceptive acts or practices to include, among others: making a misrepresentation, a misleading omission, or a statement that is likely to lead a reasonably prudent person to a false material conclusion about an insurance policy.

This means an insurance advertisement or communication must not contain a material misstatement, a misleading omission, or a statement likely to mislead a reasonable person about the terms, benefits, or cost of a policy.

This applies to all insurance advertising in Texas, including internet content and AI-assisted communications.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'tdi-advertising-rules',
    canonical_url: 'https://www.tdi.texas.gov/rules/2020/documents/20216773.pdf',
    title: 'TDI Adopted Advertising Rules (28 TAC Section 21.104)',
    author_or_owner: 'Texas Department of Insurance',
    jurisdiction: 'Texas',
    product_category: 'regulation',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'tdi21_104_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `The Texas Department of Insurance adopted advertising rules under 28 TAC Section 21.104. Key requirements:

1. An advertisement must identify the responsible person or entity. For general-coverage advertising, the agent's full licensed name, registered assumed name, or Texas license number may be used.

2. Internet content that does not mention a specific policy or offer an application/quote may be classified as an "institutional advertisement."

3. Content that invites a person to inquire about or contract for insurance must include the insurer's full licensed name.

4. Under 28 TAC Section 21.122(c), an agent must submit affected advertising to the insurer for written approval before use.

5. Under 28 TAC Section 21.116, insurers must maintain advertising specimens for at least three years.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'naic-model-570',
    canonical_url: 'https://content.naic.org/sites/default/files/model-law-570.pdf',
    title: 'NAIC Model 570 — Life Insurance and Annuities Advertising Model',
    author_or_owner: 'National Association of Insurance Commissioners',
    jurisdiction: 'National (model law)',
    product_category: 'advertising',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'naic570_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `NAIC Model 570 addresses life insurance and annuities advertising. It seeks full and truthful disclosure of material information in advertisements.

The model requires that advertisements do not mislead purchasers and that all material information is disclosed. This includes information about policy benefits, limitations, exclusions, and costs.

The model is a template that states may adopt. It is not Texas law unless Texas has adopted it. Texas has its own advertising rules under 28 TAC Section 21.104 and related provisions. Do not imply that NAIC models are Texas law unless a Texas source verifies adoption.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'tdpsa-overview',
    canonical_url:
      'https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-privacy-rights/texas-data-privacy-and-security-act',
    title: 'Texas Data Privacy and Security Act (TDPSA) — Consumer Privacy Rights',
    author_or_owner: 'Texas Attorney General',
    jurisdiction: 'Texas',
    product_category: 'privacy',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'tdpsa_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `The Texas Data Privacy and Security Act (TDPSA) took effect July 1, 2024. It applies to entities conducting business in Texas or producing products/services consumed by Texas residents that process personal data.

Key provisions for covered controllers:
- Must provide a clear privacy notice describing categories, purposes, sharing, third parties, and consumer-rights methods
- Collection must be adequate, relevant, and reasonably necessary (data minimization)
- Must maintain reasonable security and processor contracts
- Sensitive data (including physical or mental health conditions and diagnoses) requires consent before processing
- Sensitive-data or heightened-risk processing requires a data-protection assessment

There is a small-business exemption, but even exempt small businesses must obtain consent before selling sensitive data.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'term-vs-whole',
    canonical_url: 'https://lifepolicypilot.blog/term-vs-whole-life/',
    title: 'Term vs. Whole Life Insurance — Understanding the Basics',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_term_vs_whole_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Term life insurance provides coverage for a specific period, such as 10, 20, or 30 years. It pays a death benefit if the insured dies during the term. It does not build cash value and is generally less expensive than permanent coverage.

Whole life insurance is a type of permanent life insurance that provides coverage for the insured's entire lifetime, as long as premiums are paid. It builds cash value on a tax-deferred basis and has level premiums.

Key differences:
- Term is temporary and typically lower cost
- Whole life is permanent and builds cash value
- Term has no cash value component
- Whole life premiums are generally higher

Which is right for a specific person depends on their individual circumstances, goals, and budget. A licensed broker can review those factors and provide individualized guidance. This educational article cannot recommend a specific policy or coverage amount.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'factors-affecting-cost',
    canonical_url: 'https://lifepolicypilot.blog/factors-affecting-life-insurance-cost/',
    title: 'Factors That May Affect Life Insurance Cost',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_factors_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Several general factors may affect the cost of life insurance. This is educational information; a reliable personalized premium requires a licensed review of individual circumstances.

General factors that may influence cost include:
- Age: premiums are generally lower when purchased at a younger age
- Product type: term, whole, and universal life have different cost structures
- Coverage amount (face value): higher death benefits generally cost more
- Term length: longer terms generally cost more than shorter terms
- Underwriting class: determined by the carrier's underwriting process
- Carrier: different insurers price differently
- Riders and features: additional benefits add cost

A reliable personalized premium cannot be determined from age alone. It requires a licensed review including carrier-specific underwriting, product selection, and approved factors. Do not share medical history or health details in a public chat.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'coverage-needs-dime',
    canonical_url: 'https://lifepolicypilot.blog/coverage-needs-estimator/',
    title: 'How Much Life Insurance Do I Need? — The DIME Method (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_dime_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Estimating how much life insurance coverage you might need is a general educational exercise, not a personalized recommendation.

A common general method for thinking about coverage needs is the DIME method: Debt, Income, Mortgage, and Education. It adds up a family's major obligations and goals to produce a starting point for discussion.

- Debt: outstanding debts a family would still need to pay
- Income: the years of income a family would want to replace
- Mortgage: any remaining mortgage balance
- Education: future expenses such as college funding

Actual coverage needs vary widely with income, debts, family size, and goals. No general estimate can substitute for a licensed review of an individual situation.

Life Policy Pilot offers a simple 3-step educational exercise based on this general method. Its result is an illustrative range only, not a recommendation or a quote.

A reliable personalized assessment requires a licensed review of your individual circumstances.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'faq-no-advice',
    canonical_url: 'https://lifepolicypilot.blog/faq/',
    title: 'Life Policy Pilot FAQ — Common Questions',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'Texas',
    product_category: 'faq',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_faq_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Frequently Asked Questions:

Q: Can this website recommend a specific policy?
A: No. This website provides general educational information. Richard Parslow is a licensed Texas life-insurance broker who can provide individualized guidance through a separate, secured process.

Q: Can I get a quote online?
A: A reliable personalized premium requires a licensed review of your individual circumstances. Use the contact form or scheduling tool to connect with Richard Parslow.

Q: What should I not share in the chat?
A: Do not enter medical history, Social Security numbers, financial-account data, or other highly sensitive information in the chat. If you need to share such information, it will be handled through a secure, consented process.

Q: What is legacy planning?
A: Legacy planning generally refers to arranging how assets pass to beneficiaries. It may involve life insurance, trusts, and estate considerations. Tax-advantaged strategies should be discussed with a qualified tax or legal professional. This chat does not provide tax, legal, or estate-planning advice.        Q: Where can I file a complaint?
        A: You can contact the Texas Department of Insurance at tdi.texas.gov or Richard Parslow directly for policy service requests.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'iul-overview',
    canonical_url: 'https://lifepolicypilot.blog/indexed-universal-life/',
    title: 'Indexed Universal Life (IUL) — How It Works (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_iul_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Indexed Universal Life (IUL) is a general category of permanent life insurance. It provides lifetime coverage and includes a cash value component whose growth is linked to a market index, such as the S&P 500, subject to the policy's crediting method. This is general educational information, not a recommendation of any specific policy or carrier.

How the cash value grows: In an IUL, interest credited to the cash value is based on the performance of an external index over a crediting period, up to a cap and applied at a participation rate. The policy does not directly own stocks or mutual funds; it credits interest according to the index formula in the contract.

Caps and participation rates: A cap is the maximum rate the policy may credit in a period, and a participation rate is the percentage of the index's gain that is credited. Because of caps, participation rates, and fees, IUL growth may be less than the index itself in strong periods. These features vary by carrier and policy.

Is the principal guaranteed: An IUL typically includes a guaranteed floor, so interest crediting does not go below a stated minimum in a given period. However, the cash value can still be reduced by monthly policy charges, and the floor applies to interest crediting rather than guaranteeing the total cash value. A floor is not a guarantee that total cash value never declines.

Accessing cash value while alive: Many permanent policies, including some IULs, allow the owner to borrow against or withdraw from the cash value. Loans and withdrawals can reduce the death benefit and cash value and may have tax consequences. Availability and terms vary by contract, so the specific policy document controls.

Flexible premiums: Universal-life-style policies, including IUL, often allow flexible premiums within policy limits. Underfunding over time can reduce cash value or risk the policy lapsing, depending on the contract.

If the market performs poorly: Because IUL interest crediting is linked to an index, cash-value growth in poor market periods may be lower or at the floor, subject to the cap, participation rate, and charges. IUL is a life insurance product, not a securities investment, and its suitability depends on individual circumstances.

Costs associated with an IUL: IUL policies may include cost-of-insurance charges, administrative fees, and optional rider charges. These are deducted from the cash value and can affect long-term performance.

IUL compared with term: IUL is permanent, can build cash value, and generally costs more than term life. Comparing them for investment purposes depends on the individual's goals, time horizon, and tolerance for market-linked growth. This education cannot determine which is better for a specific person; a licensed broker can review individual circumstances.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'group-life-overview',
    canonical_url: 'https://lifepolicypilot.blog/employer-group-life-insurance/',
    title: 'Employer-Sponsored (Group) Life Insurance — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_group_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Employer-sponsored life insurance, also called group life insurance, is coverage an employer offers to employees, often as part of a benefits package. It is usually term coverage of a limited amount. This is general educational information and is not specific to any employer's plan.

Is employer-provided life insurance free: Some employers pay all or part of the premium for a basic amount of coverage, so the employee pays little or nothing. Other plans require the employee to pay all or part of the cost. Whether it is free, how much coverage is automatic, and any premium cost are set by the specific plan.

Automatic coverage and medical exam: Basic group life coverage often requires no medical exam and may be available with a short application. Some plans offer additional or guaranteed-issue coverage without answering health questions, subject to election windows. Whether an exam is needed depends on the plan and the amount elected.

If you leave your job: Group coverage is generally tied to employment, and it typically ends or becomes limited when you leave. Many plans allow converting to an individual policy or portability, but there are usually deadlines and limited time to elect. Whether conversion is available depends on the plan and carrier.

Death benefit taxability: Whether a death benefit is taxable depends on the policy type and the insured's circumstances. General education cannot determine tax treatment for a specific policy, and tax questions should be reviewed with a qualified tax professional.

Who chooses the beneficiary: The policyholder or insured generally names the beneficiary under the plan's rules. This varies by plan and by any beneficiary designation rules the employer contract sets. Beneficiary planning may involve legal considerations best reviewed with appropriate professionals.

Relying solely on employer coverage: Group coverage is often a helpful starting point, but it may be limited in amount and tied to employment. Whether to supplement it depends on individual coverage needs, budget, and the long-term value of keeping coverage independent of an employer. A licensed broker can help review individual circumstances.

Voluntary life insurance: Voluntary life insurance is additional group coverage an employee may choose and pay for, usually through payroll deduction, on top of any basic employer-paid amount. It is still subject to the plan's terms, amounts, and enrollment rules.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'underwriting-detail',
    canonical_url: 'https://lifepolicypilot.blog/underwriting-and-rates/',
    title: 'Life Insurance Underwriting and Rate Setting (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_underwriting_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Life insurance premiums are set by the carrier's underwriting process, which evaluates risk factors for the applicant. This is general educational information about how rate setting works; a specific premium requires a licensed review with the carrier.

Primary factors: Carriers generally consider factors such as age, health, tobacco use, coverage amount, policy type, term length, and the rating class assigned through underwriting. No single factor determines the premium alone; they are weighed together.

Health history: An applicant's health history can affect the cost, because carriers use medical information to assess risk. This is educational context, not an evaluation of any individual's health. Do not share medical history in a public chat.

Tobacco and smoking: Tobacco use generally increases premiums compared with a nonsmoker, because it is associated with higher mortality risk. Non-tobacco rates typically apply only after a stated tobacco-free period, set by the carrier.

Gender and marital status: Carriers may consider factors such as age and gender in pricing; marital status is generally not a standard pricing factor. Whether and how a factor is used varies by carrier and jurisdiction.

Body Mass Index: Height and weight, including Body Mass Index (BMI), can be considered in underwriting and affect the rating class. This varies by carrier.

Policy type and term length: Term and permanent policies have different cost structures, and for term policies a longer term typically costs more than a shorter term for the same coverage amount. Riders and additional features can increase cost.

Medical exam: Whether an exam is required depends on the policy type, coverage amount, and carrier. Smaller policies may use no medical exam or simplified underwriting, while larger amounts often require one.

Occupation and hobbies: Some occupations and hobbies involve elevated risk and may affect the rating, depending on the carrier's guidelines.

Why a premium might change: A premium is set at underwriting based on the factors above. Premium changes after purchase are governed by the policy type; term premiums are typically guaranteed for the level period, while some policies can change. A rate increase is generally not caused simply by filing a claim; policies pay claims rather than repricing based on them. Individual situations vary, so a licensed broker can explain how underwriting applies to a specific case.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'riders-overview',
    canonical_url: 'https://lifepolicypilot.blog/life-insurance-riders/',
    title: 'Life Insurance Riders — What They Are (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_riders_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `A life insurance rider is an optional add-on to a life insurance policy that provides an extra benefit or changes how the base coverage works under specific conditions. This is general educational information, not a recommendation of any rider. Whether a rider is useful depends on a person's circumstances, which a licensed broker can review.

Common rider types: Common examples include an accelerated death benefit rider, which may allow access to part of the death benefit early if the insured is diagnosed with a terminal illness defined by the policy; a waiver-of-premium rider, which can stop premium payments for a covered period if the insured becomes disabled under the rider terms; a child term rider, which provides coverage on a child for a set period; an accidental death benefit rider, which can pay an additional amount if death is accidental; and a guaranteed insurability rider, which lets the owner buy additional coverage at set times without a new medical exam. Availability and terms vary by carrier and policy.

How much riders cost: Rider pricing is set by the carrier and depends on the policy, the rider type, the coverage amount, and the applicant's circumstances. This education cannot name a charge or compare rider costs across carriers. A licensed broker can explain the charges for a specific policy.

Availability on all policies: Riders are not universally available. Whether a given rider can be added depends on the issuer, the base policy type, and the product. Not every policy supports every rider.

Removing a rider: Some riders can be added or removed according to the policy contract, and some have limited availability windows. Whether and how a rider can be removed is governed by the specific contract, so a licensed broker can review the terms of a particular policy.

Tax status of the death benefit: This is general education, not tax advice. Whether a rider or benefit is taxable depends on the policy, the rider, and the insured's circumstances. A qualified tax professional should address a particular situation.

Rider versus a separate policy: Whether to add a rider or buy a separate policy is an individualized decision that depends on the person's goals, budget, and coverage needs. This education cannot recommend one over the other. A licensed broker can review the options.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'add-overview',
    canonical_url: 'https://lifepolicypilot.blog/accidental-death-and-dismemberment/',
    title: 'Accidental Death & Dismemberment (AD&D) — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_add_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Accidental Death & Dismemberment (AD&D) insurance pays a benefit in specific situations involving an accident. It is a distinct general category from standard life insurance, which pays a death benefit on death from most causes. This is general educational information, not a recommendation of any policy.

What AD&D covers: AD&D typically pays a death benefit when the insured dies as a direct result of an accident and, under many policies, a benefit if the insured loses a limb, sight, or hearing in an accident (dismemberment) as defined by the policy. Every policy defines what counts as an accident and what limits apply, so the specific contract controls.

Coverage for disease or illness: AD&D is generally limited to accidental causes and does not pay for death from disease or illness. Whether a particular event qualifies as an accident is defined by the policy. This is a general explanation; the specific definitions in a policy determine coverage.

How "accident" is defined: Policies define accident with specific language, and the definition varies by contract. Some policies exclude certain activities or circumstances. Whether a given accident qualifies is determined by the policy's definitions and the carrier's review of a claim.

Time limits for filing a claim: Policies usually set a deadline for notifying the carrier and filing a claim, and the length varies by policy. The policy document states the applicable time limit.

Premiums and medical exam: AD&D premiums are often different from those for standard life insurance because the coverage is narrower and limited to accidental causes. Some AD&D policies may be available without a traditional medical exam, but requirements vary by carrier and policy.

Multiple disabilities from one accident: How a policy handles multiple losses from a single accident is specified in the contract, often with caps on the total benefit. The policy document controls.

Tax status: This is general education, not tax advice. Whether an AD&D benefit is taxable depends on the policy type and the insured's circumstances. A qualified tax professional should address a particular situation.

Travel coverage: Some policies offer an additional or higher benefit for accidents that occur while traveling, subject to the policy's terms and any limits. Availability varies by carrier and policy.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'final-expense-overview',
    canonical_url: 'https://lifepolicypilot.blog/final-expense-insurance/',
    title: 'Final Expense Life Insurance — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_finalexp_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Final expense life insurance is a category of life insurance designed to help cover end-of-life costs such as a funeral and related expenses. It is a general product category; this is educational information, not a recommendation of any specific policy.

What final expense insurance covers: Final expense coverage is generally intended to help pay for costs like a funeral, burial or cremation, and related end-of-life expenses. The specific benefits and what they cover are defined by the policy, and the amounts are typically modest compared with income-replacement life insurance.

How much coverage is available: Final expense policies generally offer a limited range of coverage amounts intended to cover end-of-life costs. The exact amounts available vary by carrier and policy. This education cannot quote a range for a specific policy.

Medical exam and health conditions: Some final expense policies use simplified or guaranteed-issue underwriting, which may mean fewer health questions or no medical exam. This can make coverage available to people with serious health conditions, but the terms, available amounts, and any waiting periods vary by carrier and policy. A licensed broker can review what is available for a person's situation.

Premiums over time: Some final expense policies have level premiums, while others can differ; premium behavior is set by the contract. Whether a given policy's premium will increase is determined by the specific policy terms.

Average funeral cost and cash value: This education does not provide an average funeral cost figure, because costs vary by location and choices, and figures would be ungrounded. Whether a final expense policy builds cash value depends on the policy type; some do and others do not. This is a general explanation, not a figure or a recommendation.

Eligibility and getting started: Eligibility varies by carrier and product, and some final expense policies are available to people later in life or with health conditions. How to get started depends on the selected carrier and policy, so a licensed broker can explain the options and process for a specific situation.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'child-life-overview',
    canonical_url: 'https://lifepolicypilot.blog/child-life-insurance/',
    title: 'Life Insurance for Children — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'lpp_child_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Life insurance for children is a general category of coverage on a child's life. Whether it is appropriate for a family is an individualized decision; this is general educational information, not a recommendation.

Why someone might insure a child: People consider child life insurance for reasons such as covering unexpected final expenses, preserving future insurability, or building cash value, depending on the policy type. There is no single reason; families weigh it differently. This education does not recommend buying or not buying coverage for a child.

Legality of insuring a minor: Life insurance on a minor is lawful in the United States when there is an insurable interest, and the rules about who may own the policy and how benefits are handled are set by state law and the policy. This is a general factual statement, and a licensed professional can address state-specific rules.

The main benefit of insuring young: One common reason cited is that coverage obtained while young may be more affordable or help lock in insurability, but whether that applies depends on the policy and carrier. This is a general explanation, not a guarantee of any outcome.

Cash value: Some child life insurance policies are permanent and can build cash value; others are term-like and do not. Whether a given policy builds cash value depends on the policy type and contract. This is a general definition.

Cost and replacing group coverage: The cost of insuring a child varies by carrier, the amount of coverage, and the applicant's circumstances, so this education cannot quote a cost. Child life insurance is generally not designed to replace employer-provided group life coverage, which serves a different purpose. This is a general explanation.

Risks covered besides death: Beyond a death benefit, some child policies may include features like an accelerated death benefit or would address certain conditions as defined by the policy, but there is no standard set of covered risks. The specific policy contract defines what is covered. This is general education.

Prioritizing coverage for the family: Many financial recommendations focus coverage on those whose income or care others depend on before covering dependents. Whether to prioritize coverage on a parent or on children is an individualized decision that a licensed professional should help evaluate; this education does not recommend an order.

College savings: Some child life insurance policies build cash value that could be used for purposes over time, but life insurance is not a college savings vehicle like a 529 plan, and this education does not recommend using it that way. Tax and savings questions should be reviewed with a qualified professional.

What happens at age 18: Policies on children can have different provisions when the child reaches the age of majority, such as giving the adult control of the policy or offering conversion options; the specific terms are set by the contract and state rules. A licensed broker can explain what applies to a particular policy.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'mortgage-protection-overview',
    canonical_url: 'https://lifepolicypilot.blog/mortgage-protection/',
    title: 'Mortgage Protection Insurance — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_mortgage_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Mortgage protection insurance is a marketing label for decreasing-term life insurance sized to pay off a mortgage balance if the insured dies. This is general educational information, not a recommendation of any specific policy.

What mortgage protection actually is: The most common version is decreasing term life insurance, where the death benefit starts at the mortgage balance and drops each year on a schedule that roughly matches loan amortization. A newer version is level-benefit mortgage protection, which is functionally identical to a standard level term policy but marketed toward homeowners. Both flavors pay the beneficiary you name, not the lender directly.

Why level term usually costs less: For applicants who qualify for fully underwritten preferred or preferred-plus rates, a standard level term policy matched to the mortgage payoff date is generally less expensive per dollar of coverage than a comparably sized decreasing-term mortgage protection policy, because simplified-issue underwriting pools higher-risk applicants and direct-mail distribution carries high acquisition costs baked into the premium.

When mortgage protection makes sense: Three scenarios may flip the math. First, applicants who cannot medically qualify for fully underwritten coverage may find simplified-issue mortgage protection is the only meaningful coverage available. Second, applicants over a certain age buying on a retirement home may find a shorter decreasing-term policy competitive. Third, families who want a specific mortgage-payoff guarantee separate from other coverage sometimes buy a small decreasing-term rider as an accounting convenience.

Return-of-premium variations: Some mortgage protection carriers market return-of-premium riders that refund premiums if you outlive the term. The rider typically raises the premium significantly, and the refund is not adjusted for inflation. This is a general explanation; individual suitability depends on circumstances a licensed broker can review.

Beneficiary and lender: The death benefit pays your named beneficiary, not the lender. Naming the lender surrenders the flexibility that makes life insurance valuable. This is general education, not legal or tax advice.

Credit life insurance: Credit life insurance is a separate product typically sold at loan closing where the lender is the beneficiary and coverage cancels when the loan is paid off. It is generally considered less favorable compared to individually owned term life insurance. This is a general statement, not a recommendation.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'pandemic-quarantine-overview',
    canonical_url: 'https://lifepolicypilot.blog/pandemic-quarantine/',
    title: 'Life Insurance and Pandemics / Quarantine — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_pandemic_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Life insurance and pandemic-related questions involve how policies respond during public health emergencies. This is general educational information, not a recommendation or legal advice.

Does life insurance cover pandemic deaths: Standard life insurance policies generally pay a death benefit regardless of the cause of death, including deaths caused by infectious disease or pandemic. The specific policy terms and any exclusions in the contract determine coverage. Most modern policies do not exclude pandemic-related deaths, but the specific policy document controls.

Will premiums increase because of quarantine: Being quarantined or having been quarantined is generally not a factor that carriers use in premium setting. Premiums are set at underwriting based on the factors evaluated at that time. A quarantine period itself does not typically trigger a rate increase on an existing policy.

Can I buy a new policy while in quarantine: Whether a carrier will issue a new policy during quarantine depends on the carrier's underwriting guidelines, the application process (whether it requires a medical exam or lab work), and the applicant's health status at the time of application. Some carriers adapted their processes during public health emergencies. A licensed broker can explain what specific carriers offer.

What if I cannot pay premiums during quarantine: Most policies include a grace period after a missed premium during which coverage stays in force. The exact length and effect depend on the policy and state rules. Some carriers may offer additional flexibility during declared emergencies. A licensed broker or the carrier directly can explain options for a specific policy.

Does employer-sponsored coverage continue during quarantine: Group coverage is generally tied to employment status rather than physical presence. Whether coverage continues during quarantine depends on the employer's plan and whether the employment relationship continues. The plan document controls.

How the pandemic changed underwriting: The insurance industry adapted underwriting processes during public health emergencies, including expanded use of accelerated underwriting and remote data collection. The long-term impact on underwriting practices varies by carrier. This is general context, not a prediction.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'insurable-interest-overview',
    canonical_url: 'https://lifepolicypilot.blog/insurable-interest/',
    title: 'Insurable Interest — Who Can Buy Life Insurance for Others (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_insurable_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Insurable interest is a legal requirement meaning the person buying the policy must have a legitimate financial or emotional stake in the continued life of the insured. This is general educational information, not legal advice.

What insurable interest means: Without insurable interest, a life insurance policy could be used as a wager on someone's death. The requirement exists to prevent that. The specific legal definition and how it is applied are set by state law and the policy.

Who generally has insurable interest: Spouses are generally presumed to have insurable interest in each other. Parents generally have insurable interest in their minor children. Business partners may have insurable interest in each other for key-person or buy-sell arrangements. Employers may have insurable interest in key employees. The specifics depend on state law and the relationship.

Can I buy life insurance on someone without their knowledge: Generally, the insured person must consent to being insured and typically must sign the application, answer underwriting questions, and in many cases undergo underwriting steps. Purchasing a policy on someone without their knowledge or consent is generally not permitted. The specific requirements are set by state law and the carrier's process.

Can parents buy for adult children: Whether a parent has insurable interest in an adult child depends on the relationship and state law. The adult child's consent is generally required. A licensed professional can address state-specific rules.

Can I buy for elderly parents: Adult children may have insurable interest in elderly parents, particularly when the child would be responsible for final expenses or lost financial support. The parent's consent is generally required, and the parent typically must participate in the underwriting process. This is a general statement; a licensed professional can address specifics.

Can a business buy for employees: Businesses may purchase key-person life insurance or fund buy-sell agreements with life insurance on owners or critical employees. The business must demonstrate insurable interest and obtain the employee's consent. This is general education, not legal or tax advice.

What happens if the insured dies before the policy is issued: If the insured person dies during the underwriting process before the policy is issued, there is generally no death benefit because no contract was formed. Some applications may include conditional binding coverage, but this depends on the specific carrier and product. The application terms control.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'occupation-hobby-risk-overview',
    canonical_url: 'https://lifepolicypilot.blog/occupation-hobby-risk/',
    title: 'Occupational and Hobby Risk in Life Insurance (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_occupation_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Certain occupations and recreational activities may affect life insurance underwriting and premiums. This is general educational information, not an evaluation of any individual's risk.

How occupation affects underwriting: Carriers may consider the applicant's occupation when assessing risk. Occupations involving physical danger, exposure to hazardous materials, or high-stress environments may be rated differently. The specific occupations that trigger additional review and how they affect rates vary by carrier.

How hobbies affect underwriting: Recreational activities such as aviation, rock climbing, scuba diving, motor racing, and similar pursuits may be considered by underwriters. The impact depends on the specific activity, frequency of participation, and the carrier's guidelines. Some carriers are more lenient with certain activities than others.

Disclosure is important: Applicants are generally asked about their occupation and hazardous activities on the application. Providing accurate information is important because a policy can be contested or rescinded for material misstatements during the contestability period. This is a general statement about the importance of accuracy, not legal advice.

Can I hide a dangerous hobby: Deliberately omitting information about a hazardous activity on an application is a material misstatement. If discovered, it may result in rescission of the policy or denial of a claim. This education does not recommend or endorse non-disclosure. The consequences of misrepresentation are set by state law and the policy terms.

Do I need to update my insurer about new activities: Whether a policyholder must notify the carrier after the policy is issued about new occupations or hobbies depends on the policy terms. Many policies do not require ongoing disclosure after issuance, but the specific contract controls. A licensed broker can explain what applies to a particular policy.

Are there carriers that specialize in high-risk applicants: Some carriers and brokers focus on impaired-risk or high-risk underwriting. Whether a specific carrier is more favorable for a specific occupation or hobby depends on that carrier's underwriting guidelines. This education cannot compare carriers or recommend one. A licensed broker can review options.

Can I buy coverage that specifically covers work-related accidents: Accidental death and dismemberment (AD&D) insurance and riders can provide additional coverage for accidental death. AD&D is a separate category from standard life insurance and has its own definitions and limitations. This is general education about product categories, not a recommendation.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'mib-overview',
    canonical_url: 'https://lifepolicypilot.blog/mib/',
    title: 'Medical Information Bureau (MIB) — Overview (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_mib_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `The Medical Information Bureau (MIB) is a membership organization of insurance carriers that shares coded medical and non-medical underwriting information among member companies. This is general educational information, not legal advice.

What the MIB is: The MIB is not a medical record database. It does not contain full medical records, prescriptions, or diagnoses. It contains coded codes representing brief underwriting-relevant findings that member carriers report when they process an application. The purpose is to help member carriers detect material omissions or inconsistencies between applications.

How the MIB affects applications: When you apply to a member carrier, that carrier may query the MIB. If a previous application to another member carrier resulted in a coded report, the querying carrier may see that code. The code itself does not determine the outcome; the carrier will still conduct its own underwriting. A code may prompt additional questions or a request for more information.

Can I see my own MIB report: Consumers may request a copy of their MIB file annually at no charge. The MIB provides a process for requesting and reviewing your own report. Contact information is available on the MIB website. This is a general factual statement.

Does the MIB contain all medical records: No. The MIB contains only coded underwriting information reported by member carriers. It does not contain medical records from doctors, hospitals, pharmacies, or other healthcare sources. It is separate from prescription databases and from the general medical record system.

How long does information stay in the MIB: Information reported to the MIB is generally retained for a period of years, after which it is removed. The specific retention period is set by MIB policies and applicable regulations. A licensed professional can confirm current retention practices.

Can I correct incorrect information in my MIB report: The MIB provides a dispute process for consumers who believe their file contains inaccurate information. If a correction is made, the updated information is shared with member carriers. This is a general statement about the process, not legal advice.

Do employers check the MIB: Employers offering group life insurance generally do not query the MIB for basic group coverage. Group underwriting is typically simpler than individual underwriting. Whether any specific employer or plan queries the MIB depends on the plan design. This is a general statement.

How can I improve my chances despite MIB flags: The best approach is to answer application questions truthfully and completely. If a previous application was declined or rated, the reason for that outcome is more relevant to a new carrier than the MIB code itself. A licensed broker can help present the application accurately and direct it to carriers whose underwriting may be more favorable for the applicant's profile. This is general education, not a guarantee of any outcome.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'premium-basics',
    canonical_url: 'https://lifepolicypilot.blog/premium-basics/',
    title: 'Life Insurance Premiums — What They Are and How They Work (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_premium_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `A premium is the amount you pay for life insurance coverage, typically on a schedule such as monthly, quarterly, or annually. This is general educational information; a specific premium requires a licensed review of individual circumstances.

What a premium pays for: The premium compensates the carrier for the risk it assumes, and it also covers the carrier's costs of administration, distribution, and (for permanent policies) funding the policy's cash-value and other features. How the premium is allocated among these components is set by the contract and the carrier's filings.

Level premiums: Many term policies have level premiums, meaning the premium is fixed for the length of the level term. Many whole life policies also have level premiums designed to remain constant for life. Whether a specific policy's premium is level is determined by the contract. A policy quoting a low starting premium that can increase with age may not be a level-premium product, and the illustration should be read carefully.

What affects the premium amount: Premiums are generally influenced by factors such as age, health, tobacco use, coverage amount, policy type, term length, and the underwriting class assigned. No single factor determines the premium alone; carriers weigh them together. This education cannot quote a premium for a specific person.

Payment frequency: Policies often allow different payment frequencies, such as monthly, quarterly, semi-annual, or annual. Whether a specific frequency is available and whether there is any difference in total cost by frequency depends on the carrier and the contract.

If a premium is missed: Most policies include a grace period after a missed premium during which coverage remains in force. If the premium is not paid by the end of the grace period, the policy may lapse or convert to a reduced or extended benefit as set by the contract and state rules. The policy document controls.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'beneficiary-designations',
    canonical_url: 'https://lifepolicypilot.blog/beneficiary-designations/',
    title: 'Beneficiary Designations — Types and Rules (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_beneficiary_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `A beneficiary is the person or entity named to receive the death benefit when the insured passes away. This is general educational information, not legal advice; beneficiary decisions may involve legal considerations best reviewed with appropriate professionals.

Primary and contingent beneficiaries: Policies generally allow a primary beneficiary (first in line to receive the benefit) and one or more contingent beneficiaries (who receive it if the primary beneficiary has predeceased or is otherwise unable to receive it). How shares are divided among multiple beneficiaries is set by the designation.

Revocable beneficiary: A revocable beneficiary can be changed or removed by the policyowner at any time without the beneficiary's consent. Most personal life insurance designations are revocable. The policy contract and state law govern how changes are made.

Irrevocable beneficiary: An irrevocable beneficiary generally cannot be changed or removed without that beneficiary's written consent. Because the beneficiary holds a vested interest, certain policy actions — such as borrowing against the cash value, surrendering the policy, or changing the designation — may also require that beneficiary's consent. Irrevocable designations are sometimes used in divorce settlements, structured settlements, or other situations where a party wants assurance the coverage stays in place. Whether and how these limits apply is set by the policy contract and state law.

Minors as beneficiaries: Minor children generally cannot receive proceeds directly. Common approaches include naming a custodian under a state's uniform transfers-to-minors law, naming a trust, or using the carrier's retained-asset or annuity settlement options. Which approach fits a family is an individualized decision; a licensed professional and, where appropriate, an attorney can advise.

Keeping designations current: Beneficiary designations generally control over wills, so major life events — marriage, divorce, births, deaths — are common reasons to review and update designations. Some states have laws affecting designations after divorce. The policy contract and state law control.

Estate considerations: Naming an estate as beneficiary or using life insurance in estate planning involves legal and tax considerations. This education cannot advise on those decisions; a qualified attorney and tax professional are best placed to help.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'policy-lapse-and-reinstatement',
    canonical_url: 'https://lifepolicypilot.blog/policy-lapse-reinstatement/',
    title: 'Policy Lapse, Grace Periods, and Reinstatement (Educational)',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-31',
    effective_date: '2026-08-31',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_lapse_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Life insurance policies include provisions governing what happens when premiums are not paid. This is general educational information; the specific policy contract and state rules control.

Grace period: Most policies include a grace period after a missed premium — a window during which coverage remains in force even though the payment is late. If the premium is paid within the grace period, coverage continues without interruption. The length of the grace period is set by the contract and state law, and many states require a minimum period for life policies.

Lapse: If the premium is not paid by the end of the grace period, the policy may lapse — that is, coverage ends. What happens to a permanent policy's cash value at lapse depends on the contract; many policies offer non-forfeiture options.

Non-forfeiture options: Permanent policies typically include non-forfeiture provisions, such as reduced paid-up insurance (a lower amount of coverage that requires no further premiums) or extended term insurance (the same face amount for a limited period). The availability and mechanics of these options are set by the contract.

Reinstatement: Many carriers allow a lapsed policy to be reinstated within a limited period, often several years, typically requiring payment of past-due premiums with interest and evidence of insurability. Whether reinstatement is available and on what terms is set by the contract and state law.

Avoiding an accidental lapse: Policyowners can reduce the risk of an unintended lapse by keeping payment methods current, understanding the grace period in their contract, and responding to carrier notices. A waiver-of-premium rider, where available, can keep coverage in force during a qualifying disability. This is general education, not a recommendation of any rider or policy.`,
    ),
    chunk_count: 1,
  },
];

/**
 * Simple keyword-based retrieval for the pilot phase.
 * In production, replace with hybrid lexical + semantic retrieval.
 *
 * Scores each document by counting keyword matches from the query,
 * weighted by corpus priority (lower priority number = higher weight).
 *
 * @param query - The user's question
 * @param topK - Maximum number of passages to return (default 3 per Section 4.6)
 * @returns Retrieved passages ranked by score, with sufficient-evidence flag
 */

/**
 * Retrieves a single corpus document by its id (used by the Contextual
 * Content Bridge to fetch the article currently being read). Returns null
 * when the id is unknown or the document is not currently valid/current.
 */
export function getArticleById(id: string): CorpusDocument | null {
  const now = new Date();
  const doc = pilotCorpus.find((d) => d.id === id);
  if (doc && isDocumentValid(doc, now)) {
    return doc;
  }
  return null;
}

/**
 * Retrieves RAG passages, optionally prioritizing the article a user is
 * currently reading (Contextual Content Bridge).
 *
 * When {@link contextualArticleId} is provided and present in the corpus, its
 * passages are boosted (score × 1.2, the spec's +20%) so the on-page article
 * surfaces first when it matches the query; other sources are still retrieved.
 * When the article is absent or the query is unrelated to it, the boosted
 * passages simply don't outrank the matches, preserving normal retrieval.
 *
 * @param query - The user's question
 * @param topK - Maximum number of passages to return (default 3 per Section 4.6)
 * @param options - Optional contextual article id for prioritization
 * @returns Retrieved passages ranked by score, with sufficient-evidence flag
 */
export function retrieveFromCorpus(
  query: string,
  topK: number = 3,
  options: { contextualArticleId?: string | null } = {},
): RetrievalResult {
  const now = new Date();
  const queryTokens = tokenize(query.toLowerCase());

  if (queryTokens.length === 0) {
    return { passages: [], hasSufficientEvidence: false };
  }

  const scored = pilotCorpus
    .filter((doc) => isDocumentValid(doc, now))
    .map((doc) => {
      const contentLower = doc.content.toLowerCase();
      const titleLower = doc.title.toLowerCase();

      let matchCount = 0;
      for (const token of queryTokens) {
        // Word-boundary match with plural tolerance: a token like "premium"
        // also matches "premiums", and "policy" also matches "policies".
        // Plain substring matching (without \b) previously inflated scores
        // by hitting inside "coverage"/"message"; the boundary regex fixes
        // that while the plural tolerance closes near-miss gaps.
        const tokenRe = tokenRegex(token);
        if (tokenRe.test(contentLower)) {
          matchCount += 1;
        }
        if (tokenRe.test(titleLower)) {
          matchCount += 2; // Title matches weighted higher
        }
      }

      // Priority weight: priority 1 (Texas law) gets 3x, priority 5 (FAQ) gets 1x
      const priorityWeight = 6 - Math.min(doc.product_category === 'regulation' ? 1 : 5, 5);

      let score = matchCount * priorityWeight;

      // Contextual prioritization: boost the article the user is currently
      // reading by 20% so it surfaces first when relevant (Section 3.6).
      if (options.contextualArticleId && doc.id === options.contextualArticleId) {
        score = score * 1.2;
      }

      return {
        title: doc.title,
        url: doc.canonical_url,
        content: doc.content,
        jurisdiction: doc.jurisdiction,
        productCategory: doc.product_category,
        priority: doc.product_category === 'regulation' ? 1 : 5,
        score,
      } as RetrievedPassage;
    })
    .filter((passage) => passage.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Sufficient evidence: at least one passage with a meaningful score
  const hasSufficientEvidence = scored.length > 0 && scored[0].score >= 2;

  return {
    passages: scored,
    hasSufficientEvidence,
  };
}

/**
 * Tokenizes a query string into lowercase search tokens.
 * Removes common stop words and punctuation.
 */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'should',
    'could',
    'may',
    'might',
    'must',
    'can',
    'shall',
    'to',
    'of',
    'in',
    'for',
    'on',
    'at',
    'by',
    'with',
    'from',
    'as',
    'into',
    'about',
    'what',
    'which',
    'who',
    'whom',
    'whose',
    'when',
    'where',
    'why',
    'how',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'nor',
    'not',
    'only',
    'same',
    'than',
    'too',
    'very',
    'i',
    'me',
    'my',
    'we',
    'our',
    'you',
    'your',
    'he',
    'she',
    'it',
    'they',
    'them',
    'their',
    'this',
    'that',
    'these',
    'those',
    'and',
    'or',
    'but',
    'if',
    'then',
    'else',
    'so',
    'up',
    'out',
    'its',
    'my',
  ]);

  return text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

/**
 * Builds a word-boundary regex for a token that also accepts common English
 * plural variants, so a singular query token ("premium") matches the plural
 * form in a corpus title ("premiums") and vice-versa. This prevents
 * near-miss false abstentions like "What is a premium?" failing to surface
 * the "Life Insurance Premiums" doc.
 *
 *   premium  → \bpremiums?\b       (matches premium, premiums)
 *   policy   → \bpolic(?:y|ies)\b  (matches policy, policies)
 *   box      → \box(?:es)?\b       (matches box, boxes)
 *
 * Words ending in 'ss' (boss, loss) are left as-is.
 */
function tokenRegex(token: string): RegExp {
  if (token.length > 4 && token.endsWith('y')) {
    const stem = token.slice(0, -1);
    return new RegExp(`\\b${stem}(?:y|ies)\\b`);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return new RegExp(`\\b${token}(?:es)?\\b`);
  }
  // Default: accept an optional trailing 's' so singular also matches plural.
  return new RegExp(`\\b${token}s?\\b`);
}

/**
 * Formats retrieved passages into a context string for the LLM prompt.
 * Each passage includes its title, URL, and content.
 * The content is already sanitized during ingestion.
 */
export function formatRetrievedContext(passages: RetrievedPassage[]): string {
  if (passages.length === 0) {
    return '';
  }

  return passages
    .map((p, i) => {
      return `[Source ${i + 1}]\nTitle: ${p.title}\nURL: ${p.url}\nJurisdiction: ${p.jurisdiction}\nContent:\n${p.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Gets the citations from retrieved passages for the response schema.
 */
export function passagesToCitations(
  passages: RetrievedPassage[],
): Array<{ title: string; url: string }> {
  return passages.map((p) => ({ title: p.title, url: p.url }));
}
