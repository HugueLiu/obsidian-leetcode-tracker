/**
 * 所有 GraphQL 查询集中在这里。
 * 力扣已禁用 schema 内省（__type 返回 null），字段名无法自动发现，
 * 一旦某天失效，只需要改这一个文件。
 */

export const Q_PROBLEMS = `
query problemsetQuestionList($limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList(categorySlug: "", limit: $limit, skip: $skip, filters: $filters) {
    total
    hasMore
    questions {
      frontendQuestionId
      titleSlug
      title
      titleCn
      difficulty
      acRate
      paidOnly
      status
      topicTags { slug name nameTranslated }
    }
  }
}`;

/**
 * 头像也在 userStatus 里（实测该字段是标量，未登录时返回 null），
 * 所以拿用户名和头像不需要额外一次请求。
 */
export const Q_USER_STATUS = `
query {
  userStatus { isSignedIn username isPremium avatar }
}`;

/**
 * questionSlug 是关键参数：传了就是"查这道题的全部提交历史"，
 * 不受全局 offset 2000 上限影响（实测能拉到 2017 年）。
 * 不传则是全局最新列表，最多只能翻 2000 条。
 */
export const Q_SUBMISSIONS = `
query submissionList($offset: Int, $limit: Int, $questionSlug: String) {
  submissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) {
    lastKey
    hasNext
    submissions {
      id
      status
      timestamp
      lang
      title
      runtime
      memory
      url
    }
  }
}`;

export const Q_USER_PROGRESS = `
query {
  userProgressQuestionList {
    totalNum
    questions { titleSlug title difficulty lastSubmittedAt numSubmitted }
  }
}`;

export interface GqlProblemNode {
  frontendQuestionId: string;
  titleSlug: string;
  title: string;
  titleCn: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  acRate: number;
  paidOnly: boolean;
  status: string;
  topicTags: { slug: string; name: string; nameTranslated: string }[];
}

export interface GqlSubmissionNode {
  id: string;
  status: string;
  /** 力扣返回的是字符串形式的 unix 秒 */
  timestamp: string;
  lang: string;
  title: string;
  runtime: string;
  memory: string;
  url: string;
}

export interface GqlProgressNode {
  titleSlug: string;
  title: string;
  difficulty: string;
  lastSubmittedAt: string;
  numSubmitted: number;
}
