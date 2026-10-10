// Reviews a seller's buyers left on their own site before EasyNotes (shared with the reviewers' permission), keyed by
// storefront slug. They show in the normal reviews list tagged "Bought via <source>", not "Verified purchase",
// since those purchases weren't made on EasyNotes. Add a rating (1-5) only if the reviewer gave one.
module.exports = {
  'pgda-notes-by-courts': {
    source: 'pgdanotes.co.za',
    url: 'https://pgdanotes.co.za/#reviews',
    reviews: [
      {
        name: 'Raquel P.',
        body: 'I loved these PGDA notes! They broke down the content into bite-sized, easy to understand sections and included practical examples that made applying the theory much easier. I especially found the Auditing notes helpful when the class material felt a bit disorientated. Everything was explained so simply, which helped me feel confident that I had mastered the content and made a big difference when attempting past test questions.',
      },
      {
        name: 'Anonymous student',
        body: [
          'Hey Courts! I really like your notes, especially because of how practical they are. They don’t just teach the principles — they also focus on exam technique and, importantly, how to structure an answer, using simple practical examples to make the concepts easier to apply.',
          'I also really like how I feel after working through them. I feel more confident and have a much better mindset going into practice questions because I feel like I’m not only learning the content, but also preparing myself for how I’m actually going to answer the questions in the exam.',
          'Another thing I appreciate is that you really focus on what’s important. Sometimes lectures can go off on different tangents and you end up wondering what you actually need to take from it. Your notes cut through that and keep me focused on the key principles and what I need to know.',
          'Overall, they’ve been really helpful for me, particularly because they bridge the gap between understanding the content and actually being able to apply it in a question.',
        ].join('\n\n'),
      },
    ],
  },
};
