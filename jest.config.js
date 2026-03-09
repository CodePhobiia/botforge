module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.js'],
    coverageDirectory: 'coverage',
    testPathIgnorePatterns: ['/node_modules/']
};
