// Sample payload used only when the page is opened outside Telegram (no init
// data), so the layout can be checked in a plain browser. Shaped exactly like
// what tgcloud/endpoints/getDashboard.js returns.

const TODAY = '2026-10-10';

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
};

// A believable reader: most days on, a few off, one long Sunday.
const PATTERN = [
  22, 0, 31, 18, 0, 44, 26, 12, 0, 0, 35, 28, 19, 52,
  24, 0, 30, 41, 16, 0, 38, 22, 27, 0, 33, 45, 21, 26,
];

const days = PATTERN.map((pages, i) => ({ day: addDays(TODAY, i - (PATTERN.length - 1)), pages }));

const weeks = Array.from({ length: 8 }, (_, w) => {
  const start = addDays('2026-08-24', w * 7);
  const totals = [104, 138, 96, 162, 121, 149, 155, 139];
  return { start, end: addDays(start, 6), pages: totals[w], goal: 150 };
});

const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, i) => {
  const day = addDays('2026-10-05', i);
  const found = days.find((d) => d.day === day);
  return {
    day,
    label,
    pages: day <= TODAY ? (found?.pages ?? 0) : null,
    met: day <= TODAY ? (found?.pages ?? 0) >= 10 : null,
  };
});

const weekPages = weekDays.reduce((s, d) => s + (d.pages ?? 0), 0);

export const DEMO = {
  now: { day: TODAY, year: 2026 },
  user: {
    firstName: 'Паша',
    weeklyGoalPages: 150,
    dailyMinPages: 10,
    yearGoalBooks: 12,
    remindAt: '21:00',
    tzOffset: 180,
  },
  today: { day: TODAY, pages: 26, min: 10 },
  week: {
    start: '2026-10-05',
    end: '2026-10-11',
    pages: weekPages,
    goal: 150,
    left: Math.max(0, 150 - weekPages),
    daysLeft: 1,
    daysMet: weekDays.filter((d) => d.met).length,
    elapsed: 6,
    days: weekDays,
  },
  pace: 24.6,
  speed: 41,
  days,
  weeks,
  activeBook: {
    id: 3,
    title: 'Думай медленно, решай быстро',
    author: 'Даниэль Канеман',
    status: 'reading',
    currentPage: 218,
    totalPages: 420,
    rating: null,
    hasFile: true,
    pagesLeft: 202,
    etaDays: 9,
    stats: { pages: 218, minutes: 530, days: 11, sessions: 14 },
  },
  books: [
    {
      id: 3,
      title: 'Думай медленно, решай быстро',
      author: 'Даниэль Канеман',
      status: 'reading',
      currentPage: 218,
      totalPages: 420,
      rating: null,
      hasFile: true,
      pagesLeft: 202,
      etaDays: 9,
      finishedAt: null,
      stats: { pages: 218, minutes: 530, days: 11, sessions: 14 },
    },
    {
      id: 2,
      title: 'Чистый код',
      author: 'Роберт Мартин',
      status: 'finished',
      currentPage: 464,
      totalPages: 464,
      rating: 4,
      hasFile: true,
      pagesLeft: 0,
      etaDays: 0,
      finishedAt: '2026-09-21T19:40:00.000Z',
      stats: { pages: 464, minutes: 1120, days: 19, sessions: 24 },
    },
    {
      id: 1,
      title: 'Краткая история времени',
      author: 'Стивен Хокинг',
      status: 'finished',
      currentPage: 231,
      totalPages: 231,
      rating: 5,
      hasFile: false,
      pagesLeft: 0,
      etaDays: 0,
      finishedAt: '2026-07-04T08:10:00.000Z',
      stats: { pages: 231, minutes: 600, days: 9, sessions: 11 },
    },
    {
      id: 4,
      title: 'Дорога',
      author: 'Кормак Маккарти',
      status: 'queued',
      currentPage: 0,
      totalPages: 288,
      rating: null,
      hasFile: true,
      pagesLeft: 288,
      etaDays: 12,
      finishedAt: null,
      stats: { pages: 0, minutes: 0, days: 0, sessions: 0 },
    },
  ],
  year: { year: 2026, done: 2, goal: 12 },
  contract: {
    id: 1,
    startDay: '2026-09-28',
    endDay: '2026-10-27',
    days: 30,
    dailyMinPages: 10,
    weeklyGoalPages: 150,
    progress: { elapsed: 13, met: 10, missed: 3, pages: 341, daysLeft: 17, adherence: 77, done: false },
  },
  totals: { pages: 913, minutes: 2250, days: 39 },
  quotes: [
    { id: 2, bookId: 3, page: 201, text: 'Ничто в жизни не так важно, как нам кажется, пока мы об этом думаем.' },
    { id: 1, bookId: 2, page: 88, text: 'Единственный способ идти быстро — идти хорошо.' },
  ],
  eta: { days: 9, day: '2026-10-19' },
};
