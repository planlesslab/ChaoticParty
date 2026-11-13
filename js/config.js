// Every tunable number in one place (see GAME_DESIGN.md §1).
export default {
  minPlayers: 3,
  maxPlayers: 10,
  roundsPerGame: 10,
  getReadyMs: 3000,
  roundMs: 20000,
  sayAnswerMs: 5000,
  points: { placing: [3, 2, 1], group: 3, sayFirst: 3, sayRebuzz: 2 },
  hostHandoverMs: 15000,
  nameMaxLength: 12,
};
