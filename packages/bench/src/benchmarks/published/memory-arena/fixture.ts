export interface ArenaAnswer {
  target_asin?: string;
  attributes?: string[];
  [key: string]: unknown;
}

export type ArenaExpectedAnswer =
  | ArenaAnswer
  | string
  | Array<ArenaAnswer | string>;

export interface ArenaTask {
  id: number;
  questions: string[];
  answers: ArenaExpectedAnswer[];
  category: string;
}

export interface DomainData {
  domain: string;
  tasks: ArenaTask[];
}

export const MEMORY_ARENA_SMOKE_FIXTURE: DomainData[] = [
  {
    domain: "bundled_shopping",
    tasks: [
      {
        id: 1,
        category: "bundled_shopping",
        questions: [
          "What snack did we decide to buy for the train ride?",
          "Which snack from earlier should I pack in the bag now?",
        ],
        answers: [
          { attributes: ["trail mix"] },
          { attributes: ["trail mix"] },
        ],
      },
    ],
  },
];
